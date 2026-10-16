/**
 * Seeded randomness for the ranker (PLAN "Reproducibility: the RNG is seeded per digest and the seed is stored").
 * One 32-bit seed per digest derives independent streams (Thompson samples, the wildcard roll/pick, wildcard
 * sources), so the same seed and the same learner state reproduce the same digest.
 */
import { randomInt } from 'node:crypto';

export type Rng = () => number;

/** mulberry32: small, fast, good enough for sampling; returns [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent stream `n` of a digest seed. */
export function stream(seed: number, n: number): Rng {
  return mulberry32((seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0);
}

/** A fresh digest seed (stored on digests.rng_seed and digest_rankings.seed). */
export const newSeed = (): number => randomInt(1, 2 ** 31 - 1);

/** Standard normal (Box–Muller). */
export function normal(rng: Rng): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) — Marsaglia & Tsang, with the shape < 1 boost. */
export function gamma(rng: Rng, shape: number): number {
  if (!(shape > 0) || !Number.isFinite(shape)) throw new RangeError('gamma shape must be > 0');
  if (shape < 1) {
    let u = 0;
    while (u <= Number.EPSILON) u = rng();
    return gamma(rng, shape + 1) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(α, β) sample in (0, 1). */
export function beta(rng: Rng, alpha: number, betaParam: number): number {
  const x = gamma(rng, alpha);
  const y = gamma(rng, betaParam);
  const s = x + y;
  return s > 0 ? x / s : 0.5;
}

/** Uniform pick (undefined for an empty list). */
export function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
  if (!items.length) return undefined;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
