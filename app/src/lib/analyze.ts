/**
 * analyze.ts — the degradation analysis pipeline.
 *
 * Stage 1 (heavy, cached): resize -> Lab + gray -> k-means -> black-hat.
 * Stage 2 (fast, re-run on slider change): classify clusters into
 *   mold / peeling / intact, threshold the black-hat into cracks,
 *   then measure surface percentages and connected regions.
 */
import {
  rgbToLab, rgbToGray, kmeansLab, blackHat, openMask, connectedComponents,
  type LabImage, type KMeansResult,
} from './cv';

export type DefectClass = 'mold' | 'crack' | 'peel';

export interface Sensitivity {
  mold: number;  // 0..100
  crack: number; // 0..100
  peel: number;  // 0..100
}

export interface ClassStats {
  px: number;
  pct: number;        // % of total surface
  regions: number;    // distinct connected regions above min size
  largestPct: number; // largest single region, % of total surface
}

export interface Features {
  width: number;
  height: number;
  rgb: Uint8ClampedArray;      // downscaled RGBA
  lab: LabImage;
  gray: Float32Array;
  blackhat: Float32Array;
  km: KMeansResult;
  /** mean Lab per cluster */
  clusterL: number[]; clusterA: number[]; clusterB: number[];
}

export interface AnalysisResult {
  width: number;
  height: number;
  originalUrl: string;
  overlayUrl: string;
  maskUrls: Record<DefectClass, string>;
  stats: Record<DefectClass | 'intact', ClassStats>;
  score: number;          // 0..100 weighted degradation index
  severity: string;
}

export const CLASS_COLORS: Record<DefectClass, [number, number, number]> = {
  mold: [240, 180, 41],   // amber
  crack: [56, 189, 248],  // sky
  peel: [251, 113, 133],  // rose
};

export const ANALYSIS_MAX_WIDTH = 480;

// ---------------------------------------------------------------------------
// Stage 1 — feature extraction (expensive, cached per image)
// ---------------------------------------------------------------------------

export function extractFeatures(img: HTMLImageElement | HTMLCanvasElement): Features {
  const scale = Math.min(1, ANALYSIS_MAX_WIDTH / img.width);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const rgb = imageData.data;

  const lab = rgbToLab(rgb, width, height);
  const gray = rgbToGray(rgb, width, height);
  const km = kmeansLab(lab, 5);
  // structuring element radius scaled to image size — catches hairline cracks
  const r = Math.max(2, Math.round(width / 120));
  const blackhat = blackHat(gray, width, height, r);

  // per-cluster mean Lab
  const k = km.k;
  const sL = new Float64Array(k), sA = new Float64Array(k), sB = new Float64Array(k);
  for (let i = 0; i < width * height; i++) {
    const c = km.labels[i];
    sL[c] += lab.L[i]; sA[c] += lab.a[i]; sB[c] += lab.b[i];
  }
  const clusterL: number[] = [], clusterA: number[] = [], clusterB: number[] = [];
  for (let c = 0; c < k; c++) {
    const n = Math.max(1, km.counts[c]);
    clusterL.push(sL[c] / n); clusterA.push(sA[c] / n); clusterB.push(sB[c] / n);
  }

  return { width, height, rgb, lab, gray, blackhat, km, clusterL, clusterA, clusterB };
}

// ---------------------------------------------------------------------------
// Stage 2 — classification + measurement (cheap, re-run on slider input)
// ---------------------------------------------------------------------------

export function classify(f: Features, sens: Sensitivity): AnalysisResult {
  const { width, height, km } = f;
  const n = width * height;

  // --- cluster-level classification --------------------------------------
  const k = km.k;
  let base = 0;
  for (let c = 0; c < k; c++) if (km.counts[c] > km.counts[base]) base = c;
  const baseChroma = Math.hypot(f.clusterA[base], f.clusterB[base]);

  // if the dominant cluster is itself very dark, the surface is mold-dominated:
  // treat it as mold and use the brightest cluster as the paint reference
  let baseIsMold = f.clusterL[base] < 38;
  let paintRef = base;
  if (baseIsMold) {
    let best = -1, bestL = -1;
    for (let c = 0; c < k; c++) if (c !== base && km.counts[c] > n * 0.03 && f.clusterL[c] > bestL) { bestL = f.clusterL[c]; best = c; }
    if (best >= 0) paintRef = best;
  }

  const moldT = 30 - sens.mold * 0.22;   // 30 .. 8
  const peelT = 30 - sens.peel * 0.22;
  const clusterClass: Array<'mold' | 'peel' | 'intact'> = new Array(k).fill('intact');
  for (let c = 0; c < k; c++) {
    if (c === base) { clusterClass[c] = baseIsMold ? 'mold' : 'intact'; continue; }
    const dL = f.clusterL[c] - f.clusterL[paintRef];
    const greenShift = f.clusterA[paintRef] - f.clusterA[c]; // + means greener than paint
    const chroma = Math.hypot(f.clusterA[c], f.clusterB[c]);
    const chromaDrop = baseChroma - chroma;

    const moldScore = Math.max(0, -dL) + Math.max(0, greenShift) * 1.5 + (f.clusterL[c] < 42 ? 8 : 0);
    const peelScore = Math.max(0, dL) + Math.max(0, chromaDrop) * 0.8 + (chroma < 14 && dL > 4 ? 6 : 0);

    if (moldScore > moldT && moldScore >= peelScore) clusterClass[c] = 'mold';
    else if (peelScore > peelT) clusterClass[c] = 'peel';
  }

  // --- pixel masks ---------------------------------------------------------
  const moldMask = new Uint8Array(n);
  const peelMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const cls = clusterClass[km.labels[i]];
    if (cls === 'mold') moldMask[i] = 1;
    else if (cls === 'peel') peelMask[i] = 1;
  }

  // cracks: threshold the black-hat, keep thin/elongated components only
  const crackT = 26 - sens.crack * 0.18; // 26 .. 8
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (f.blackhat[i] > crackT) raw[i] = 1;
  const crackMask = new Uint8Array(n);
  const comps = connectedComponents(raw, width, height, 4);
  for (const c of comps) {
    const w = c.maxX - c.minX + 1, h = c.maxY - c.minY + 1;
    const fill = c.size / (w * h);
    const aspect = Math.max(w / h, h / w);
    const elongated = aspect >= 2.6 || fill < 0.35;
    const small = c.size < n * 0.015;
    if (elongated && small) {
      for (let y = c.minY; y <= c.maxY; y++)
        for (let x = c.minX; x <= c.maxX; x++)
          if (raw[y * width + x]) crackMask[y * width + x] = 1;
    }
  }

  // denoise color masks with a small opening (speckle removal)
  const moldClean = openMask(moldMask, width, height, 1);
  const peelClean = openMask(peelMask, width, height, 1);

  // peel-patch edges cast thin shadows that mimic cracks — suppress crack
  // pixels within 2px of a peeling region
  const peelHalo = dilateMask(peelClean, width, height, 2);
  for (let i = 0; i < n; i++) if (peelHalo[i]) crackMask[i] = 0;

  // --- measurement ---------------------------------------------------------
  const minRegion = Math.max(6, Math.round(n * 0.0005)); // 0.05% of image
  const measure = (mask: Uint8Array): ClassStats => {
    let px = 0;
    for (let i = 0; i < n; i++) px += mask[i];
    const regions = connectedComponents(mask, width, height, minRegion);
    let largest = 0;
    for (const r of regions) largest = Math.max(largest, r.size);
    return { px, pct: (px / n) * 100, regions: regions.length, largestPct: (largest / n) * 100 };
  };

  const moldS = measure(moldClean);
  const peelS = measure(peelClean);
  const crackS = measure(crackMask);
  const defectPx = moldS.px + peelS.px + crackS.px;
  const intactS: ClassStats = {
    px: n - defectPx,
    pct: ((n - defectPx) / n) * 100,
    regions: 0, largestPct: 0,
  };

  // weighted degradation index
  const score = Math.min(100, moldS.pct * 1.0 + peelS.pct * 0.9 + crackS.pct * 1.4);
  const severity =
    score < 2 ? 'Sound' :
    score < 10 ? 'Light degradation' :
    score < 25 ? 'Moderate degradation' :
    score < 50 ? 'Severe degradation' : 'Critical degradation';

  // --- rendering -----------------------------------------------------------
  const originalUrl = renderOriginal(f);
  const overlayUrl = renderOverlay(f, moldClean, peelClean, crackMask);
  const maskUrls = {
    mold: renderMask(f, moldClean, 'mold'),
    peel: renderMask(f, peelClean, 'peel'),
    crack: renderMask(f, crackMask, 'crack'),
  };

  return {
    width, height, originalUrl, overlayUrl, maskUrls,
    stats: { mold: moldS, crack: crackS, peel: peelS, intact: intactS },
    score: Math.round(score * 10) / 10,
    severity,
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

function renderOriginal(f: Features): string {
  const c = document.createElement('canvas');
  c.width = f.width; c.height = f.height;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(f.width, f.height);
  out.data.set(f.rgb);
  ctx.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}

function renderOverlay(f: Features, mold: Uint8Array, peel: Uint8Array, crack: Uint8Array): string {
  const c = document.createElement('canvas');
  c.width = f.width; c.height = f.height;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(f.width, f.height);
  const d = out.data;
  const tint = (i: number, rgb: [number, number, number], alpha: number) => {
    d[i * 4] = f.rgb[i * 4] * (1 - alpha) + rgb[0] * alpha;
    d[i * 4 + 1] = f.rgb[i * 4 + 1] * (1 - alpha) + rgb[1] * alpha;
    d[i * 4 + 2] = f.rgb[i * 4 + 2] * (1 - alpha) + rgb[2] * alpha;
    d[i * 4 + 3] = 255;
  };
  for (let i = 0; i < f.width * f.height; i++) {
    if (crack[i]) tint(i, CLASS_COLORS.crack, 0.95);
    else if (mold[i]) tint(i, CLASS_COLORS.mold, 0.6);
    else if (peel[i]) tint(i, CLASS_COLORS.peel, 0.6);
    else {
      d[i * 4] = f.rgb[i * 4]; d[i * 4 + 1] = f.rgb[i * 4 + 1];
      d[i * 4 + 2] = f.rgb[i * 4 + 2]; d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}

function renderMask(f: Features, mask: Uint8Array, cls: DefectClass): string {
  const c = document.createElement('canvas');
  c.width = f.width; c.height = f.height;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(f.width, f.height);
  const d = out.data;
  const [r, g, b] = CLASS_COLORS[cls];
  for (let i = 0; i < f.width * f.height; i++) {
    if (mask[i]) {
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    } else {
      const v = f.gray[i] * 0.18; // faint gray backdrop for context
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}
