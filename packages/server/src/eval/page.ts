/** GET /eval/items: one cursor page of rendered items plus per-set progress (lazily sampling empty / short sets). */
import type { EvalItem, EvalItemPage, EvalItemsQuery } from '@yb/shared';
import type { DB } from '../db/connection';
import { itemVisible, renderContext, renderItem } from './render';
import { ensureSampled } from './sample';
import { pageRows, setCounts, type PageQuery } from './store';
import { SET_NAMES } from './types';

const MAX_READS = 5;

export async function itemPage(db: DB, q: EvalItemsQuery, o: { now?: number; lazySample?: boolean } = {}): Promise<EvalItemPage> {
  if (o.lazySample ?? true) await ensureSampled(db, q.set ? [q.set] : SET_NAMES, o.now);
  const r = renderContext(db);
  const base: PageQuery = { ...(q.set ? { set: q.set } : {}), status: q.status, limit: q.limit };
  const items: EvalItem[] = [];
  let cursor = q.cursor;
  // Items about people hidden since sampling are skipped, so a page may take a few reads to fill.
  for (let reads = 0; reads < MAX_READS && items.length < q.limit; reads++) {
    const want = q.limit - items.length;
    const rows = pageRows(db, { ...base, ...(cursor ? { cursor } : {}) }, want);
    for (const it of rows) {
      cursor = it.id;
      if (itemVisible(r, it)) items.push(renderItem(r, it));
    }
    if (rows.length < want) break; // nothing further
  }
  const more = cursor !== undefined && cursor !== q.cursor && pageRows(db, { ...base, cursor }, 1).length > 0;
  return { items, nextCursor: more ? cursor! : null, counts: setCounts(db) };
}
