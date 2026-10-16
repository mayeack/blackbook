/**
 * The /v1/contacts client and the `addressbook` job against an undici MockAgent (never the real collector: its
 * first real call would raise the macOS Contacts prompt). Synthetic cards only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MockAgent } from 'undici';
import { ContactsClient } from '../../../src/adapters/addressbook/client';
import { addressbookJobs, ADDRESSBOOK_CHECK_MS, ADDRESSBOOK_EVERY_MS } from '../../../src/adapters/addressbook/jobs';
import { CollectorContractError, CollectorHttpError, CollectorUnavailableError } from '../../../src/adapters/imessage/collectorClient';
import type { JobContext } from '../../../src/scheduler/scheduler';
import { memDb, T0, tempDir } from '../../helpers';

/** A placeholder origin, never the real collector port: the MockAgent answers and refuses everything else. */
const BASE = 'http://127.0.0.1:9';
const TOKEN = 'synthetic-test-token';

interface Reply {
  status: number;
  body: unknown;
}

class FakeContacts {
  readonly agent = new MockAgent();
  readonly tokenFile: string;
  readonly calls: string[] = [];
  token = TOKEN;
  next: Reply | null = null;
  items: unknown[] = [{ id: 'card-1', given: 'Robin', family: 'Example', phones: [{ label: 'mobile', value: '+12125550101' }] }];
  hash = 'h1';
  private readonly cleanup: () => void;

  constructor() {
    const t = tempDir('yb-contacts-');
    this.cleanup = t.cleanup;
    this.tokenFile = path.join(t.dir, 'collector.token');
    this.agent.disableNetConnect();
    this.agent
      .get(BASE)
      .intercept({ path: () => true, method: 'GET' })
      .reply((opts) => {
        this.calls.push(opts.path);
        const auth = (opts.headers as Record<string, string>).authorization;
        if (auth !== `Bearer ${this.token}`) return { statusCode: 401, data: { error: { code: 'unauthorized', message: 'bad token' } } };
        if (this.next) {
          const r = this.next;
          this.next = null;
          return { statusCode: r.status, data: r.body as object };
        }
        return { statusCode: 200, data: { api: 'v1', generated_at: T0, hash: this.hash, items: this.items } };
      })
      .persist();
  }

  writeToken(token = this.token): this {
    fs.writeFileSync(this.tokenFile, `${token}\n`, { mode: 0o600 });
    return this;
  }

  client(): ContactsClient {
    return new ContactsClient({ baseUrl: BASE, tokenFile: this.tokenFile, dispatcher: this.agent });
  }

  async close(): Promise<void> {
    await this.agent.close();
    this.cleanup();
  }
}

const fakes: FakeContacts[] = [];
const fake = () => {
  const f = new FakeContacts();
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

const jobCtx = (db: ReturnType<typeof memDb>, now: number, id = 1): JobContext => ({
  db,
  jobRunId: id,
  trigger: 'schedule',
  now: () => now,
  log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  signal: new AbortController().signal,
});

describe('ContactsClient', () => {
  it('GETs /v1/contacts with the Bearer token and validates the contract', async () => {
    const f = fake().writeToken();
    const res = await f.client().contacts();
    expect(f.calls).toEqual(['/v1/contacts']);
    expect(res.hash).toBe('h1');
    expect(res.items[0]).toMatchObject({ id: 'card-1', given: 'Robin', emails: [], social: [], birthday: null });
  });

  it('re-reads a rotated token once; maps collector errors and contract breaks', async () => {
    const f = fake().writeToken('old-token');
    f.token = 'new-token';
    const c = f.client();
    // The cached token is wrong: one 401, the file is re-read (still old) → the error surfaces.
    const err = await thrown(c.contacts());
    expect(err).toBeInstanceOf(CollectorHttpError);
    expect((err as CollectorHttpError).code).toBe('unauthorized');
    f.writeToken('new-token');
    await expect(c.contacts()).resolves.toMatchObject({ hash: 'h1' });

    f.next = { status: 403, body: { error: { code: 'contacts_denied', message: 'Contacts access denied' } } };
    const denied = await thrown(c.contacts());
    expect(denied).toMatchObject({ status: 403, code: 'contacts_denied' });

    f.next = { status: 200, body: { api: 'v1', hash: 'h', items: [{ given: 'No id' }] } };
    const broken = await thrown(c.contacts());
    expect(broken).toBeInstanceOf(CollectorContractError);
    expect((broken as CollectorContractError).message).not.toContain('No id');
  });

  it('a missing token file means the collector is not installed yet', async () => {
    const f = fake();
    const err = await thrown(f.client().contacts());
    expect(err).toBeInstanceOf(CollectorUnavailableError);
    expect((err as CollectorUnavailableError).reason).toBe('token_missing');
    expect(f.calls).toEqual([]);
  });
});

describe('addressbook job', () => {
  it('fetches at the first check after boot, then hourly; skips in between', async () => {
    const f = fake().writeToken();
    const [job] = addressbookJobs({ collectorUrl: BASE, collectorTokenFile: f.tokenFile, client: f.client() });
    expect(job).toMatchObject({ name: 'addressbook', schedule: { kind: 'interval', everyMs: ADDRESSBOOK_CHECK_MS } });
    const db = memDb();
    expect(await job!.run(jobCtx(db, T0))).toMatchObject({ stats: { cards: 1, cards_new: 1, people_created: 1 } });
    expect(await job!.run(jobCtx(db, T0 + ADDRESSBOOK_CHECK_MS))).toEqual({ status: 'skipped' });
    expect(f.calls).toHaveLength(1);
    expect(await job!.run(jobCtx(db, T0 + ADDRESSBOOK_EVERY_MS))).toMatchObject({ stats: { dump_unchanged: 1 } });
    expect(f.calls).toHaveLength(2);
    // A restarted server builds the job again: it fetches right away.
    const [again] = addressbookJobs({ collectorUrl: BASE, collectorTokenFile: f.tokenFile, client: f.client() });
    await again!.run(jobCtx(db, T0 + ADDRESSBOOK_EVERY_MS + 1));
    expect(f.calls).toHaveLength(3);
  });

  it('records health: collector missing → skipped and retried; Contacts denied → auth_required; contract break fails', async () => {
    const f = fake();
    const [job] = addressbookJobs({ collectorUrl: BASE, collectorTokenFile: f.tokenFile, client: f.client() });
    const db = memDb();
    const health = () => db.prepare(`SELECT status, last_error FROM source_health WHERE source = 'addressbook'`).get() as Record<string, unknown>;
    expect(await job!.run(jobCtx(db, T0))).toMatchObject({ status: 'skipped', stats: { collector_unavailable: 1 } });
    expect(health().status).toBe('auth_required');

    f.writeToken();
    f.next = { status: 403, body: { error: { code: 'contacts_denied', message: 'denied' } } };
    expect(await job!.run(jobCtx(db, T0 + ADDRESSBOOK_CHECK_MS))).toMatchObject({ status: 'skipped', stats: { contacts_denied: 1 } });
    expect(health()).toEqual({ status: 'auth_required', last_error: 'contacts_denied' });
    // Denied: the next attempt waits for the hour.
    expect(await job!.run(jobCtx(db, T0 + 2 * ADDRESSBOOK_CHECK_MS))).toEqual({ status: 'skipped' });

    f.next = { status: 200, body: { api: 'v1', hash: 'h', items: 'nope' } };
    await expect(job!.run(jobCtx(db, T0 + ADDRESSBOOK_CHECK_MS + ADDRESSBOOK_EVERY_MS))).rejects.toBeInstanceOf(CollectorContractError);
    expect(health().status).toBe('contract_broken');
    expect(db.prepare('SELECT count(*) FROM people').pluck().get()).toBe(0);
  });
});
