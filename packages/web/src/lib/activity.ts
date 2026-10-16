import type { ActivityPage } from '../api/types';

export type ActivityGroup = ActivityPage['groups'][number];

/** Pages are grouped by run per page; a run split across a page boundary becomes one group again. */
export function mergeGroups(groups: ActivityGroup[]): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const g of groups) {
    const last = out[out.length - 1];
    if (last && last.run.id === g.run.id) last.batches = [...last.batches, ...g.batches];
    else out.push({ run: g.run, batches: [...g.batches] });
  }
  return out;
}
