/** "What I've learned" helpers (pure; test/settings.test.ts). */
import type { KindPropensity, Trend } from '@yb/shared';

/** Unmuted kinds by propensity (most acted-on first), muted ones last; ties by how often they were shown. */
export function sortKinds(kinds: readonly KindPropensity[]): KindPropensity[] {
  return [...kinds].sort((a, b) => Number(a.muted) - Number(b.muted) || b.propensity - a.propensity || b.shown30d - a.shown30d || a.kind.localeCompare(b.kind));
}

/** "↑ 6 pts", "↓ 2 pts", "steady" (trendDelta is a 0..1 propensity change over 14 days). */
export function trendText(trend: Trend, delta: number): string {
  const pts = Math.round(Math.abs(delta) * 100);
  if (trend === 'flat' || pts === 0) return 'steady';
  return `${trend === 'up' ? '↑' : '↓'} ${pts} pt${pts === 1 ? '' : 's'}`;
}
