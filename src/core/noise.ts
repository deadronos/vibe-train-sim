// Small deterministic noise helpers: value-gradient noise, fbm and ridged fbm.

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash(ix: number, iy: number) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function grad(ix: number, iy: number, x: number, y: number) {
  const a = hash(ix, iy) * Math.PI * 2;
  return Math.cos(a) * x + Math.sin(a) * y;
}

/** Gradient noise, roughly in -0.7..0.7. */
export function noise2(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = grad(ix, iy, fx, fy);
  const b = grad(ix + 1, iy, fx - 1, fy);
  const c = grad(ix, iy + 1, fx, fy - 1);
  const d = grad(ix + 1, iy + 1, fx - 1, fy - 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise mapped to about 0..1. */
export function fbm(x: number, y: number, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * f + i * 17.3, y * f - i * 9.1) * amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return Math.max(0, Math.min(1, sum * 1.3 + 0.5));
}

/** Ridged fractal noise mapped to 0..1; sharp crests suit mountains. */
export function ridged(x: number, y: number, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * f + i * 5.7, y * f + i * 3.3)) * 2;
    const r = n * n;
    sum += r * amp * prev;
    prev = r;
    amp *= 0.5;
    f *= 2.1;
  }
  return Math.max(0, Math.min(1, sum));
}

/** Seeded PRNG for scatter passes. */
export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
