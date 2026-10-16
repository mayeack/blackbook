/**
 * Test-only HTTP setup (vitest setupFiles: runs in every test worker before its test file).
 *
 * supertest's request(app) starts a throwaway server per request with listen(0), which listens on every interface
 * ("::"), and then sends the request to 127.0.0.1:<port>. macOS hands out ephemeral ports in sequence, and other apps
 * listen on ports in that range over IPv4 (rekordbox on *:50000/55000/55002, Duo Desktop on 127.0.0.1:53100/53106).
 * A throwaway server given one of those ports never sees its request: the kernel delivers the IPv4 connection to the
 * other app's listener, so the test times out, fails with "socket hang up", or gets that app's 404. Which test fails
 * depends on where the port counter is (a full run moves it ~900), so it was a different one each time.
 * On 127.0.0.1 the throwaway server is the most specific listener on its port, and the kernel never gives it a port
 * another app holds on 127.0.0.1.
 */
import http from 'node:http';
import net from 'node:net';
import { afterAll } from 'vitest';

// listen(0, '127.0.0.1') would bind a tick later (Node looks the host up first), but supertest reads
// server.address() straight after listen(0). Without a host, listen() binds at once through _listen2, which net.js
// keeps under that name for code that wraps it: there, "no host" becomes 127.0.0.1 instead of "::" / "0.0.0.0".
type Listen2 = (this: http.Server, address: string | null, port: number, addressType: number, ...rest: unknown[]) => void;
const proto = http.Server.prototype as unknown as { _listen2: Listen2 };
const listen2 = proto._listen2;
proto._listen2 = function (address, port, addressType, ...rest) {
  return address == null && port === 0
    ? listen2.call(this, '127.0.0.1', 0, 4, ...rest)
    : listen2.call(this, address, port, addressType, ...rest);
};

// No keep-alive: each request gets its own connection, closed by the server right after its response, so nothing
// outlives the throwaway server it was made for (Node's global agent keeps sockets alive since Node 19).
http.globalAgent = new http.Agent({ keepAlive: false });

// ------------------------------------------------------------------------------------------------- egress guard
// Fail closed: tests talk only to mocks and to their own throwaway servers on 127.0.0.1. A connection to anything
// that isn't loopback, or to the real local services on this Mac (yeackbot 4320, the collector 4321, the sandbox
// browser's CDP 4331, Beeper Desktop 23373), is refused before a packet leaves, and fails the test file even when
// the code under test swallowed the error. Unix sockets (the admin socket tests) pass.
const FORBIDDEN_LOOPBACK_PORTS = new Set([4320, 4321, 4331, 23373]);
const isLoopback = (host: string) => host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(host);

type GuardState = { blocked: string[] };
const STATE = Symbol.for('yb.test.egressGuard');
const g = globalThis as unknown as Record<symbol, GuardState | undefined>;

/** host:port of a Socket#connect call (options object, [options, cb] as net.connect passes it, or port, host). */
function target(args: unknown[]): { host: string; port: number } | null {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first !== null && typeof first === 'object') {
    const o = first as { path?: unknown; port?: unknown; host?: unknown };
    if (o.path) return null;
    return { host: typeof o.host === 'string' && o.host ? o.host : 'localhost', port: Number(o.port) };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof args[1] === 'string' && args[1] ? args[1] : 'localhost', port: Number(first) };
  }
  return null; // an IPC path
}

if (!g[STATE]) {
  const state: GuardState = { blocked: [] };
  g[STATE] = state;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const t = target(args);
    if (t && (!isLoopback(t.host) || FORBIDDEN_LOOPBACK_PORTS.has(t.port))) {
      state.blocked.push(`${t.host}:${t.port}`);
      const err = Object.assign(new Error(`test egress guard: refused a connection to ${t.host}:${t.port}`), { code: 'ECONNREFUSED' });
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

afterAll(() => {
  const state = g[STATE]!;
  const blocked = state.blocked.splice(0);
  if (blocked.length) throw new Error(`a test tried to reach the network or a real local service: ${[...new Set(blocked)].join(', ')}`);
});
