/**
 * Main-thread side of the layout: talks to layout.worker.ts, or — if module workers aren't available — runs the
 * same chunks on the main thread between frames (slower, never blocks for long).
 */
import { CHUNK, LayoutRunner, type LayoutInput, type LayoutProgress, type LayoutRequest } from './layout';

export type PositionsHandler = (positions: Float32Array, done: boolean) => void;

export class LayoutClient {
  private worker: Worker | null = null;
  private workerFailed = false;
  private job = 0;
  private handler: PositionsHandler | null = null;
  private fallbackTimer: number | null = null;
  private pending: { input: LayoutInput; iterations: number } | null = null;

  private ensureWorker(): Worker | null {
    if (this.worker || this.workerFailed) return this.worker;
    try {
      const w = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'yb-layout' });
      w.addEventListener('message', (e: MessageEvent<LayoutProgress>) => {
        if (e.data.type === 'positions' && e.data.job === this.job) this.handler?.(e.data.positions, e.data.done);
      });
      w.addEventListener('error', () => {
        // Couldn't load (CSP, old browser): finish this job on the main thread.
        this.workerFailed = true;
        this.worker?.terminate();
        this.worker = null;
        if (this.handler && this.pending) this.runOnMainThread(this.job, this.pending.input, this.pending.iterations);
      });
      this.worker = w;
    } catch {
      this.workerFailed = true;
    }
    return this.worker;
  }

  start(input: LayoutInput, iterations: number, onPositions: PositionsHandler): void {
    this.stop();
    this.job += 1;
    this.handler = onPositions;
    this.pending = { input, iterations };
    const w = this.ensureWorker();
    if (w) {
      const msg: LayoutRequest = { type: 'start', job: this.job, input, iterations };
      w.postMessage(msg);
      return;
    }
    this.runOnMainThread(this.job, input, iterations);
  }

  private runOnMainThread(job: number, input: LayoutInput, iterations: number) {
    const runner = new LayoutRunner(input);
    let remaining = iterations;
    const tick = () => {
      if (job !== this.job) return;
      const n = Math.min(CHUNK, remaining);
      remaining -= n;
      const pos = runner.step(n);
      this.handler?.(pos, remaining <= 0);
      if (remaining > 0) this.fallbackTimer = window.setTimeout(tick, 16);
    };
    this.fallbackTimer = window.setTimeout(tick, 0);
  }

  stop(): void {
    this.handler = null;
    this.pending = null;
    if (this.fallbackTimer !== null) {
      window.clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.worker) {
      const msg: LayoutRequest = { type: 'stop' };
      this.worker.postMessage(msg);
    }
  }

  dispose(): void {
    this.stop();
    this.job += 1;
    this.worker?.terminate();
    this.worker = null;
  }
}
