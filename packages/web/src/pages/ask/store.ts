/**
 * Live Ask turns, outside React: a stream keeps going if the page re-renders, the URL moves from /ask to
 * /ask/:id when the server names the conversation, or the user taps away and comes back. Components read it with
 * useSyncExternalStore; stored turns (GET /ask/conversations/:id) take over once a turn is saved.
 */
import type { AskEvent } from '@yb/shared';
import { applyEvent, isActive, newTurn, type LiveTurn } from './logic';
import { isAbort, streamAsk, type StreamEnv } from './stream';

export interface AskStoreOptions {
  env: StreamEnv;
  /** A turn finished (or failed): refresh the conversation list / thread. */
  onSettled?: (turn: LiveTurn) => void;
  now?: () => number;
}

type Listener = () => void;

export class AskStore {
  private turns: LiveTurn[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<Listener>();
  private seq = 0;
  private version = 0;
  /** Called when a turn settles (the page points this at its query cache). */
  onSettled: ((turn: LiveTurn) => void) | null = null;

  constructor(private readonly o: AskStoreOptions) {}

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Changes whenever any turn changes (for useSyncExternalStore). */
  getVersion = (): number => this.version;

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private update(key: string, fn: (t: LiveTurn) => LiveTurn) {
    let changed = false;
    this.turns = this.turns.map((t) => {
      if (t.key !== key) return t;
      const next = fn(t);
      if (next !== t) changed = true;
      return next;
    });
    if (changed) this.emit();
  }

  get(key: string): LiveTurn | undefined {
    return this.turns.find((t) => t.key === key);
  }

  /** Live turns of a conversation (or the not-yet-named new thread `draft:<key>`), oldest first. */
  forConversation(conversationId: string): LiveTurn[] {
    return this.turns.filter((t) => t.conversationId === conversationId);
  }

  /** Turns started from /ask with no conversation yet (until `start` names it). */
  forDraft(draftKey: string): LiveTurn[] {
    const first = this.get(draftKey);
    if (!first) return [];
    return first.conversationId ? this.forConversation(first.conversationId) : [first];
  }

  /** True while any turn of that conversation is streaming (one question at a time per thread). */
  busy(conversationId: string | null, draftKey?: string | null): boolean {
    if (conversationId) return this.forConversation(conversationId).some(isActive);
    return draftKey ? this.forDraft(draftKey).some(isActive) : false;
  }

  /** Starts a question; returns the turn's key. */
  ask(question: string, conversationId: string | null): string {
    const key = `t${++this.seq}-${(this.o.now ?? Date.now)()}`;
    const turn = newTurn(key, question, conversationId, (this.o.now ?? Date.now)());
    this.turns = [...this.turns, turn];
    this.emit();
    const ctl = new AbortController();
    this.controllers.set(key, ctl);
    const onEvent = (e: AskEvent) => this.update(key, (t) => applyEvent(t, e));
    void streamAsk(this.o.env, { question, ...(conversationId ? { conversationId } : {}) }, onEvent, ctl.signal)
      .then(() => {
        // The stream ended without done/error (server went away): say so instead of spinning forever.
        this.update(key, (t) => (isActive(t) ? { ...t, status: 'error', error: { code: 'cut_off', message: 'The answer was cut off. Ask again.' } } : t));
      })
      .catch((e: unknown) => {
        if (isAbort(e)) this.update(key, (t) => (isActive(t) ? { ...t, status: 'stopped' } : t));
        else this.update(key, (t) => (isActive(t) ? { ...t, status: 'error', error: { code: 'request', message: e instanceof Error ? e.message : 'Ask failed.' } } : t));
      })
      .finally(() => {
        this.controllers.delete(key);
        const t = this.get(key);
        if (t) {
          this.o.onSettled?.(t);
          this.onSettled?.(t);
        }
      });
    return key;
  }

  stop(key: string): void {
    this.controllers.get(key)?.abort();
  }

  /** Stops whatever is streaming in that conversation / draft. */
  stopAll(conversationId: string | null, draftKey?: string | null): void {
    const list = conversationId ? this.forConversation(conversationId) : draftKey ? this.forDraft(draftKey) : [];
    for (const t of list) if (isActive(t)) this.stop(t.key);
  }

  /** Drops settled live turns the server has stored (by turn id), keeping the store small. */
  forgetStored(conversationId: string, storedTurnIds: ReadonlySet<string>): void {
    const before = this.turns.length;
    this.turns = this.turns.filter((t) => !(t.conversationId === conversationId && !isActive(t) && t.turnId && storedTurnIds.has(t.turnId) && t.status !== 'error'));
    if (this.turns.length !== before) this.emit();
  }
}

/**
 * Stored turns, with live ones layered on top: a live turn replaces the stored one with the same id (it has the
 * tool steps and usage), and live turns the server hasn't saved yet follow.
 */
export function mergeTurns(stored: readonly LiveTurn[], live: readonly LiveTurn[]): LiveTurn[] {
  const liveById = new Map(live.filter((t) => t.turnId).map((t) => [t.turnId!, t]));
  const out = stored.map((s) => liveById.get(s.turnId ?? '') ?? s);
  const seen = new Set(out.map((t) => t.key));
  for (const t of live) if (!seen.has(t.key) && !(t.turnId && stored.some((s) => s.turnId === t.turnId))) out.push(t);
  return out;
}
