/**
 * Streams answer text to the web while it is written: person tokens become names and citation ids no tool
 * returned are dropped, as in the final answer. A delta can end mid-token ("P1") or mid-citation ("[m:3"), so the
 * tail that could still grow into one is held back until the next delta (or the end). The final `done` event
 * carries the authoritative text; the streamed text is a preview of it.
 */
import { citationIdsIn, detokenize, validateCitations } from './refs';

/** Longest held-back tail: an open bracket further back than this is just text. */
const MAX_HOLD = 64;

export class DeltaFilter {
  private pending = '';
  private readonly announced = new Set<string>();

  constructor(
    private readonly o: {
      citable: () => ReadonlySet<string>;
      personName: (token: string) => string | null;
      me?: string;
      emit: (text: string) => void;
      /** A valid citation id first seen in the stream. */
      onCitation?: (id: string) => void;
    },
  ) {}

  push(delta: string): void {
    this.pending += delta;
    const cut = this.safeCut(this.pending);
    if (cut <= 0) return;
    this.flushPart(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
  }

  end(): void {
    if (this.pending) this.flushPart(this.pending);
    this.pending = '';
  }

  /** Index up to which the text can be processed now. */
  private safeCut(s: string): number {
    let cut = s.length;
    const open = s.lastIndexOf('[');
    if (open >= 0 && s.indexOf(']', open) < 0 && s.length - open <= MAX_HOLD) cut = open;
    // A trailing word could still become a token or "ME" ("P", "P1", "M"); very long runs are just text.
    const tail = /[A-Za-z0-9:]{1,40}$/.exec(s.slice(0, cut));
    if (tail) cut = tail.index;
    // Keep the space before a held-back citation with it, so a stripped citation leaves no stray space.
    if (cut > 0 && s[cut - 1] === ' ' && s[cut] === '[') cut--;
    return cut;
  }

  private flushPart(part: string): void {
    const v = validateCitations(part, { citable: this.o.citable() });
    for (const id of citationIdsIn(v.text)) {
      if (!this.announced.has(id)) {
        this.announced.add(id);
        this.o.onCitation?.(id);
      }
    }
    const text = detokenize(v.text, this.o.personName, this.o.me);
    if (text) this.o.emit(text);
  }
}
