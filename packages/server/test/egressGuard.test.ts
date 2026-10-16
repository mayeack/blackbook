/** The test egress guard (setup.ts) refuses the network and the real local services, and lets loopback through. */
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { request as undiciRequest } from 'undici';

const attempt = (port: number, host: string) =>
  new Promise<string>((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => {
      s.destroy();
      resolve('connected');
    });
    s.once('error', (e: NodeJS.ErrnoException) => resolve(`${e.code}: ${e.message}`));
  });

describe('test egress guard', () => {
  it('refuses non-loopback hosts and the real service ports before connecting; loopback test servers still work', async () => {
    for (const [port, host] of [[443, '192.0.2.1'], [80, 'example.com'], [23373, '127.0.0.1'], [4321, 'localhost'], [4331, '127.0.0.1'], [4320, '::1']] as const) {
      expect(await attempt(port, host)).toMatch(/^ECONNREFUSED: test egress guard/);
    }
    // undici (fetch, the source clients) goes through the same socket layer
    await expect(undiciRequest('http://127.0.0.1:23373/v1/accounts')).rejects.toThrow();
    const state = (globalThis as unknown as Record<symbol, { blocked: string[] }>)[Symbol.for('yb.test.egressGuard')]!;
    expect(new Set(state.blocked)).toEqual(new Set(['192.0.2.1:443', 'example.com:80', '127.0.0.1:23373', 'localhost:4321', '127.0.0.1:4331', '::1:4320']));
    state.blocked.length = 0; // expected refusals: don't fail this file

    const app = express().get('/ok', (_req, res) => void res.json({ ok: true }));
    expect((await request(app).get('/ok')).body).toEqual({ ok: true });
  });
});
