import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import {
  CollectorClient,
  CollectorContractError,
  CollectorHttpError,
  CollectorUnavailableError,
} from '../../../src/adapters/imessage/collectorClient';
import { imessageJobs } from '../../../src/adapters/imessage/jobs';
import { buildJobs } from '../../../src/scheduler/jobs/index';
import { Scheduler } from '../../../src/scheduler/scheduler';
import { memDb, tempDir } from '../../helpers';
import { ALEX, BASE, dm, FakeCollector, T0 } from './fakeCollector';

const fakes: FakeCollector[] = [];
const fake = () => {
  const f = new FakeCollector();
  fakes.push(f);
  return f;
};
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
};

describe('CollectorClient', () => {
  it('sends the Bearer token from the token file and validates the envelope', async () => {
    const f = fake().writeToken();
    f.add(dm(ALEX), { from: ALEX, at: T0, text: 'are you around saturday?' });
    const res = await f.client().messages({ after_rowid: 0, limit: 10 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.is_from_me).toBe(false);
    expect(res.has_more).toBe(false);
    expect(f.calls).toEqual(['/v1/imessage/messages?after_rowid=0&limit=10']);
  });

  it('re-reads the token file once after a 401, then gives up with CollectorHttpError', async () => {
    const f = fake().writeToken('old-token');
    f.token = 'old-token';
    const client = f.client();
    await client.health();
    // The collector rotated its token: the cached one now gets a 401, the re-read file has the new one.
    f.token = 'new-token';
    f.writeToken('new-token');
    await client.chats();
    expect(f.calls.length).toBe(3);

    f.token = 'rotated-again';
    const err = await thrown(client.handles());
    expect(err).toBeInstanceOf(CollectorHttpError);
    expect((err as CollectorHttpError).status).toBe(401);
    expect((err as CollectorHttpError).code).toBe('unauthorized');
    expect(f.calls.length).toBe(5); // one retry, not a loop
  });

  it('a missing token file is CollectorUnavailableError(token_missing), not a crash', async () => {
    const f = fake();
    const err = await thrown(f.client().messages({ after_rowid: 0 }));
    expect(err).toBeInstanceOf(CollectorUnavailableError);
    expect((err as CollectorUnavailableError).reason).toBe('token_missing');
    expect(f.calls).toEqual([]);
  });

  it('rejects responses that break the v1 contract without echoing their content', async () => {
    const f = fake().writeToken();
    const row = f.add(dm(ALEX), { from: ALEX, at: T0, text: 'private words' });
    row.guid = '';
    const err = await thrown(f.client().messages({ after_rowid: 0 }));
    expect(err).toBeInstanceOf(CollectorContractError);
    expect((err as CollectorContractError).paths).toEqual(['items.#.guid']);
    expect(err.message).not.toContain('private words');
  });

  it('maps the error envelope and an unreachable collector', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(BASE);
    pool.intercept({ path: '/v1/health', method: 'GET' }).reply(503, { error: { code: 'chatdb_unavailable', message: 'locked' } });
    pool.intercept({ path: '/v1/imessage/handles', method: 'GET' }).replyWithError(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }));
    const f = fake().writeToken();
    const client = new CollectorClient({ baseUrl: BASE, tokenFile: f.tokenFile, dispatcher: agent });
    const http = await thrown(client.health());
    expect(http).toBeInstanceOf(CollectorHttpError);
    expect((http as CollectorHttpError).code).toBe('chatdb_unavailable');
    const down = await thrown(client.handles());
    expect(down).toBeInstanceOf(CollectorUnavailableError);
    expect((down as CollectorUnavailableError).reason).toBe('unreachable');
    await agent.close();
  });

  it('the imessage-tail job skips (no failure backoff) until the token file exists', async () => {
    const f = fake();
    const db = memDb();
    const jobs = imessageJobs({ collectorUrl: BASE, collectorTokenFile: f.tokenFile, client: f.client() });
    const s = new Scheduler({ db, jobs, clock: { now: () => T0 } });
    expect((await s.runNow('imessage-tail')).status).toBe('skipped');
    expect(db.prepare(`SELECT status FROM source_health WHERE source = 'imessage'`).pluck().get()).toBe('auth_required');
    expect(s.status().find((j) => j.name === 'imessage-tail')!.consecutiveFailures).toBe(0);
    // Idle passes leave no journal runs behind (the first one set up the 'me' person).
    const runs = db.prepare('SELECT count(*) FROM runs').pluck();
    const before = runs.get();
    expect((await s.runNow('imessage-tail')).status).toBe('skipped');
    expect(runs.get()).toBe(before);

    f.writeToken();
    f.add(dm(ALEX), { from: ALEX, at: T0, text: 'hi' });
    expect((await s.runNow('imessage-tail')).status).toBe('ok');
    expect(db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(1);
    expect(db.prepare(`SELECT status FROM source_health WHERE source = 'imessage'`).pluck().get()).toBe('ok');
  });

  it('registers imessage-tail and imessage-overlap once the collector token path is known', () => {
    const t = tempDir();
    try {
      const paths = { backupDir: `${t.dir}/backups`, logDir: `${t.dir}/logs` };
      expect(buildJobs({ config: paths }).map((j) => j.name)).toEqual(['backup', 'logs-prune']);
      const jobs = buildJobs({ config: { ...paths, dataDir: t.dir } });
      // Other collector-backed sources register alongside; only the iMessage pair is asserted here.
      expect(jobs.map((j) => j.name).filter((n) => n.startsWith('imessage-'))).toEqual(['imessage-tail', 'imessage-overlap']);
      expect(jobs.find((j) => j.name === 'imessage-tail')!.schedule).toEqual({ kind: 'interval', everyMs: 10_000 });
      expect(jobs.find((j) => j.name === 'imessage-overlap')!.schedule).toEqual({ kind: 'daily', at: '02:30' });
    } finally {
      t.cleanup();
    }
  });
});
