/**
 * Runs a pass written as a generator of small steps (each step's writes commit in their own transaction): the
 * event loop gets a turn every `sliceMs` (so the 10 s iMessage tail and the API keep running during a long night)
 * and an aborted signal stops the pass between steps (`complete: false`; what committed stays, the next run redoes
 * the rest).
 */
export const SLICE_MS = 25;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export type StepResult<T> = { complete: true; value: T } | { complete: false; value: null };

export async function runSteps<T>(pass: Generator<void, T>, o: { sliceMs?: number; signal?: AbortSignal } = {}): Promise<StepResult<T>> {
  const slice = o.sliceMs ?? SLICE_MS;
  let since = performance.now();
  for (;;) {
    if (o.signal?.aborted) {
      pass.return(undefined as never);
      return { complete: false, value: null };
    }
    const r = pass.next();
    if (r.done) return { complete: true, value: r.value };
    if (performance.now() - since >= slice) {
      await yieldToLoop();
      since = performance.now();
    }
  }
}

/** The same pass, drained synchronously (tests, scripts). */
export function drainSteps<T>(pass: Generator<void, T>): T {
  for (;;) {
    const r = pass.next();
    if (r.done) return r.value;
  }
}
