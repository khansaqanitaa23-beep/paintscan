/**
 * samples.ts — procedurally generated wall textures so the tool can be
 * tried instantly without real photos: moldy wall, cracked facade,
 * peeling paint.
 */

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 640, H = 480;

function baseWall(ctx: CanvasRenderingContext2D, r: number, g: number, b: number, seed: number) {
  const rnd = mulberry32(seed);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, W, H);
  // paint texture noise
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 22;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // large soft shading patches (uneven lighting)
  for (let i = 0; i < 6; i++) {
    const x = rnd() * W, y = rnd() * H, rad = 120 + rnd() * 220;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const dark = rnd() > 0.5;
    grad.addColorStop(0, dark ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
}

function addMold(ctx: CanvasRenderingContext2D, spots: number, seed: number, spread = 1) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < spots; i++) {
    const cx = W * (spread === 1 ? rnd() : 0.5 + (rnd() - 0.5) * spread);
    const cy = H * (0.55 + rnd() * 0.45); // mold grows from the bottom up
    const blobs = 3 + Math.floor(rnd() * 6);
    for (let j = 0; j < blobs; j++) {
      const x = cx + (rnd() - 0.5) * 60;
      const y = cy + (rnd() - 0.5) * 60;
      const rad = 4 + rnd() * 26;
      const g = Math.floor(60 + rnd() * 60);
      const alpha = 0.25 + rnd() * 0.45;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(${g * 0.5},${g},${g * 0.55},${alpha})`);
      grad.addColorStop(0.7, `rgba(${g * 0.4},${g * 0.8},${g * 0.45},${alpha * 0.6})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function addCracks(ctx: CanvasRenderingContext2D, count: number, seed: number) {
  const rnd = mulberry32(seed);
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    let x = rnd() * W, y = rnd() * H * 0.5;
    let angle = Math.PI / 2 + (rnd() - 0.5) * 0.8;
    const steps = 30 + Math.floor(rnd() * 60);
    ctx.strokeStyle = 'rgba(25,22,20,0.85)';
    ctx.lineWidth = 1 + rnd() * 1.2;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < steps; s++) {
      angle += (rnd() - 0.5) * 0.9;
      const len = 3 + rnd() * 6;
      x += Math.cos(angle) * len;
      y += Math.sin(angle) * len;
      ctx.lineTo(x, y);
      // occasional branch
      if (rnd() < 0.08) {
        ctx.moveTo(x, y);
        const ba = angle + (rnd() > 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6);
        let bx = x, by = y;
        for (let t = 0; t < 8 + rnd() * 14; t++) {
          bx += Math.cos(ba) * 3; by += Math.sin(ba) * 3;
          ctx.lineTo(bx, by);
        }
        ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
  }
}

function addPeeling(ctx: CanvasRenderingContext2D, patches: number, seed: number, under: [number, number, number]) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < patches; i++) {
    const cx = rnd() * W, cy = rnd() * H;
    const rad = 24 + rnd() * 70;
    const pts = 9 + Math.floor(rnd() * 6);
    ctx.beginPath();
    for (let p = 0; p <= pts; p++) {
      const a = (p / pts) * Math.PI * 2;
      const rr = rad * (0.55 + rnd() * 0.6);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (p === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    // subtle edge shadow, then exposed substrate
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    ctx.fillStyle = `rgb(${under[0]},${under[1]},${under[2]})`;
    ctx.fill();
    ctx.restore();
    // plaster grain
    for (let j = 0; j < 30; j++) {
      const a = rnd() * Math.PI * 2, rr = rnd() * rad * 0.8;
      ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.08})`;
      ctx.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 2, 2);
    }
  }
}

export interface SampleDef {
  id: string;
  name: string;
  defects: string;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

export const SAMPLES: SampleDef[] = [
  {
    id: 'mold',
    name: 'Damp bathroom wall',
    defects: 'Heavy fungal growth, minor cracks',
    draw: (ctx) => {
      baseWall(ctx, 168, 175, 170, 11);
      addMold(ctx, 26, 12);
      addCracks(ctx, 3, 13);
    },
  },
  {
    id: 'crack',
    name: 'Aged exterior facade',
    defects: 'Pronounced micro-cracking',
    draw: (ctx) => {
      baseWall(ctx, 196, 188, 171, 21);
      addCracks(ctx, 9, 22);
      addMold(ctx, 4, 23);
    },
  },
  {
    id: 'peel',
    name: 'Peeling ceiling paint',
    defects: 'Widespread paint peeling',
    draw: (ctx) => {
      baseWall(ctx, 116, 138, 160, 31);
      addPeeling(ctx, 9, 32, [205, 200, 188]);
      addCracks(ctx, 3, 33);
    },
  },
];

export function renderSample(def: SampleDef): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  def.draw(ctx);
  return c;
}
