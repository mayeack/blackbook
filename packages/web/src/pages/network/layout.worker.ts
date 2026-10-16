/**
 * Same-origin module worker running ForceAtlas2 in chunks (see layout.ts). One job at a time: a new `start` or a
 * `stop` supersedes whatever is running. Positions are posted after every chunk so the map settles visibly.
 */
import { CHUNK, LayoutRunner, type LayoutProgress, type LayoutRequest } from './layout';

interface WorkerScope {
  postMessage(message: LayoutProgress, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<LayoutRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;
let current = -1;
let runner: LayoutRunner | null = null;

function run(job: number, remaining: number) {
  if (job !== current || !runner) return;
  const n = Math.min(CHUNK, remaining);
  const positions = runner.step(n);
  const done = remaining - n <= 0;
  scope.postMessage({ type: 'positions', job, positions, done }, [positions.buffer]);
  if (!done) setTimeout(() => run(job, remaining - n), 0);
}

scope.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'stop') {
    current = -1;
    runner = null;
    return;
  }
  current = msg.job;
  runner = new LayoutRunner(msg.input);
  run(msg.job, Math.max(1, msg.iterations));
});
