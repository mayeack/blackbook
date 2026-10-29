/**
 * The owner's token (ME) read back as "you": a model writes "ME's place" or "ME is hosting", which a plain
 * ME → you swap turns into "you's place" / "you is hosting". Run on de-tokenized text (llm/egress.ts, ask/refs.ts,
 * delivery/llmComposer.ts) and on stored text that went through the plain swap before (delivery/template.ts).
 */

/** Words after a possessive that leave it standing alone ("at ME's on Friday" → "at yours on Friday"). */
const STANDS_ALONE = new Set(
  'on in at for with to from by and or but then this next tonight today tomorrow after before around until till sometime later soon again too instead'.split(' '),
);
const VERB: Record<string, string> = { is: 'are', was: 'were', has: 'have', does: 'do' };

/** "you's place" → "your place", "at you's" → "at yours", "you is / was / has / does" → "you are / were / have / do". */
export function secondPerson(s: string): string {
  return s
    .replace(/\b([Yy])ou['’]s\b(\s+[\p{L}]+)?/gu, (_m, y: string, next: string | undefined) =>
      next && !STANDS_ALONE.has(next.trim().toLowerCase()) ? `${y}our${next}` : `${y}ours${next ?? ''}`,
    )
    .replace(/\b([Yy])ou (is|was|has|does)\b/g, (_m, y: string, v: string) => `${y}ou ${VERB[v]}`);
}
