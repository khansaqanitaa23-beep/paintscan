/**
 * cv.ts — lightweight computer-vision primitives (pure TypeScript).
 * Mirrors classic OpenCV operations so the same pipeline can be ported
 * 1:1 to Python + OpenCV: color-space conversion, k-means clustering,
 * grayscale morphology (black-hat transform) and connected components.
 */

// ---------------------------------------------------------------------------
// Color spaces
// ---------------------------------------------------------------------------

export interface LabImage {
  L: Float32Array;
  a: Float32Array;
  b: Float32Array;
  width: number;
  height: number;
}

/** sRGB (0-255) -> CIE L*a*b* (D65). Equivalent of cv2.cvtColor(..., COLOR_RGB2Lab). */
export function rgbToLab(data: Uint8ClampedArray, width: number, height: number): LabImage {
  const n = width * height;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let r = data[i * 4] / 255;
    let g = data[i * 4 + 1] / 255;
    let b = data[i * 4 + 2] / 255;
    // linearize
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    // sRGB -> XYZ (D65)
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    x = f(x); y = f(y); z = f(z);
    L[i] = 116 * y - 16;
    A[i] = 500 * (x - y);
    B[i] = 200 * (y - z);
  }
  return { L, a: A, b: B, width, height };
}

/** Simple luma grayscale. Equivalent of cv2.cvtColor(..., COLOR_RGB2GRAY). */
export function rgbToGray(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const n = width * height;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return g;
}

// ---------------------------------------------------------------------------
// k-means clustering (k-means++ seeding) — equivalent of cv2.kmeans
// ---------------------------------------------------------------------------

export interface KMeansResult {
  /** cluster index per pixel (length = width*height) */
  labels: Int32Array;
  /** cluster centers in Lab space */
  centers: Float32Array; // k * 3
  /** pixel count per cluster */
  counts: Int32Array;
  k: number;
}

const SCALE_AB = 100 / 128; // bring a,b onto a comparable scale with L

export function kmeansLab(lab: LabImage, k: number, iterations = 12, sampleCap = 20000): KMeansResult {
  const n = lab.width * lab.height;
  const { L, a, b } = lab;

  // deterministic subsample for fitting
  const stride = Math.max(1, Math.floor(n / sampleCap));
  const sample: number[] = [];
  for (let i = 0; i < n; i += stride) sample.push(i);
  const m = sample.length;

  // --- k-means++ seeding ------------------------------------------------
  const centers = new Float32Array(k * 3);
  const rnd = mulberry32(42);
  const first = sample[Math.floor(rnd() * m)];
  centers[0] = L[first]; centers[1] = a[first] * SCALE_AB; centers[2] = b[first] * SCALE_AB;
  const dist = new Float32Array(m).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let s = 0; s < m; s++) {
      const i = sample[s];
      const dx = L[i] - centers[(c - 1) * 3];
      const dy = a[i] * SCALE_AB - centers[(c - 1) * 3 + 1];
      const dz = b[i] * SCALE_AB - centers[(c - 1) * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < dist[s]) dist[s] = d;
      sum += dist[s];
    }
    let target = rnd() * sum;
    let chosen = sample[m - 1];
    for (let s = 0; s < m; s++) {
      target -= dist[s];
      if (target <= 0) { chosen = sample[s]; break; }
    }
    centers[c * 3] = L[chosen];
    centers[c * 3 + 1] = a[chosen] * SCALE_AB;
    centers[c * 3 + 2] = b[chosen] * SCALE_AB;
  }

  // --- Lloyd iterations on the subsample --------------------------------
  const assign = new Int32Array(m);
  for (let it = 0; it < iterations; it++) {
    const sums = new Float64Array(k * 3);
    const counts = new Int32Array(k);
    for (let s = 0; s < m; s++) {
      const i = sample[s];
      const li = L[i], ai = a[i] * SCALE_AB, bi = b[i] * SCALE_AB;
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = li - centers[c * 3];
        const dy = ai - centers[c * 3 + 1];
        const dz = bi - centers[c * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[s] = best;
      sums[best * 3] += li; sums[best * 3 + 1] += ai; sums[best * 3 + 2] += bi;
      counts[best]++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centers[c * 3] = sums[c * 3] / counts[c];
        centers[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
        centers[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
      }
    }
  }

  // --- assign every pixel to nearest center ------------------------------
  const labels = new Int32Array(n);
  const counts = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const li = L[i], ai = a[i] * SCALE_AB, bi = b[i] * SCALE_AB;
    let best = 0, bestD = Infinity;
    for (let c = 0; c < k; c++) {
      const dx = li - centers[c * 3];
      const dy = ai - centers[c * 3 + 1];
      const dz = bi - centers[c * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    labels[i] = best;
    counts[best]++;
  }
  return { labels, centers, counts, k };
}

// ---------------------------------------------------------------------------
// Grayscale morphology (flat square structuring element, separable min/max)
// Equivalent of cv2.morphologyEx with MORPH_CLOSE / MORPH_OPEN
// ---------------------------------------------------------------------------

function slidingExtrema(src: Float32Array, w: number, h: number, r: number, isMin: boolean): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const k = 2 * r + 1;
  // horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let ext = isMin ? Infinity : -Infinity;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let i = x0; i <= x1; i++) {
        const v = src[row + i];
        ext = isMin ? Math.min(ext, v) : Math.max(ext, v);
      }
      tmp[row + x] = ext;
    }
  }
  // vertical pass
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let ext = isMin ? Infinity : -Infinity;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let j = y0; j <= y1; j++) {
        const v = tmp[j * w + x];
        ext = isMin ? Math.min(ext, v) : Math.max(ext, v);
      }
      out[y * w + x] = ext;
    }
  }
  void k;
  return out;
}

export function erode(src: Float32Array, w: number, h: number, r: number) { return slidingExtrema(src, w, h, r, true); }
export function dilate(src: Float32Array, w: number, h: number, r: number) { return slidingExtrema(src, w, h, r, false); }

/**
 * Black-hat transform: closing(gray) - gray.
 * Highlights structures that are DARKER than their surroundings and smaller
 * than the structuring element — exactly what micro-cracks look like.
 */
export function blackHat(gray: Float32Array, w: number, h: number, r: number): Float32Array {
  const closed = erode(dilate(gray, w, h, r), w, h, r); // closing = dilate -> erode
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.max(0, closed[i] - gray[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Binary mask morphology + connected components
// ---------------------------------------------------------------------------

export function openMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const er = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ok = 1;
      outer: for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) { ok = 0; break outer; }
        }
      }
      er[y * w + x] = ok;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      outer: for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && er[ny * w + nx]) { v = 1; break outer; }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export interface Component {
  size: number;
  minX: number; minY: number; maxX: number; maxY: number;
}

/** 4-connected component labelling. Equivalent of cv2.connectedComponentsWithStats. */
export function connectedComponents(mask: Uint8Array, w: number, h: number, minSize = 1): Component[] {
  const seen = new Uint8Array(mask.length);
  const comps: Component[] = [];
  const stack = new Int32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    let size = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      size++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (size >= minSize) comps.push({ size, minX, minY, maxX, maxY });
  }
  return comps;
}

/** deterministic PRNG for reproducible k-means++ seeding */
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
