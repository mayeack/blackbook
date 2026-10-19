/** The egress choke point: pseudonymizer, fail-closed scanner, stable tokens, local de-tokenization, egressFetch. */
import { describe, expect, it } from 'vitest';
import { EgressBlocked } from '../../src/llm/types';
import {
  createEgress,
  DeltaDetokenizer,
  detokenizeKeepingCitations,
  EGRESS_BLOCKED_HEADER,
  egressFetch,
  EgressRefused,
  findRawIdentifiers,
  mayHoldPhone,
  nextPersonOrdinal,
  personIdsIn,
  scanFindings,
  scanRequestBody,
  tokensIn,
} from '../../src/llm/egress';
import { memDb, seedIdentity, seedPerson } from '../helpers';

function world() {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', first_name: 'Owner', last_name: 'Self', display_name: 'Owner Self' });
  const avery = seedPerson(db, { first_name: 'Avery', last_name: 'Quill', display_name: 'Avery Quill' });
  const robin = seedPerson(db, { first_name: 'Robin', last_name: 'Vale', display_name: 'Robin Vale' });
  const ghost = seedPerson(db, { first_name: null, last_name: null, display_name: '(212) •••-••77', status: 'provisional' });
  seedIdentity(db, avery, 'phone', '+12125550123');
  seedIdentity(db, avery, 'instagram_username', 'avery.q');
  const unknown = seedIdentity(db, ghost, 'phone', '+12125550177');
  seedIdentity(db, me, 'phone', '+12125550100');
  return { db, egress: createEgress(db), me, avery, robin, ghost, unknown };
}

describe('pseudonymize', () => {
  it('scrubs phones, emails, handles, URLs, addresses, digit runs and last names; keeps first names, cities, refs', () => {
    const { egress, avery, robin, me, unknown } = world();
    const p = egress.pseudonymize({
      purpose: 'extract',
      people: [
        { personId: avery, firstName: 'Avery', lastName: 'Quill' },
        { personId: robin, firstName: 'Robin', lastName: 'Vale' },
        { personId: me, firstName: 'Owner', isMe: true },
      ],
      identityIds: [unknown],
      sections: [
        {
          name: 'window',
          text: [
            '[m:8812|2026-10-12 19:04|P1→ME] Avery Quill said call (212) 555-0123 or +1 212 555 0177',
            '[m:1234567|2026-10-12 19:05|ME] ping avery@example.com or dm @avery.q / @someone_new',
            'party at 1200 Maple Ave in Springfield, code 48151623, see https://events.example.com/e/abc?ref=q',
            'robin vale and Robin Vale are at Acme Corp in Austin; my num 212.555.0100',
          ].join('\n'),
        },
      ],
    });
    const t = p.sections[0]!.text;
    expect(t.replace(/<link:[^>]+>/g, '')).not.toMatch(/555|example\.com|@avery|@someone|Quill|Vale|1200 Maple|48151623/);
    expect(t).toContain('Avery Q. said');
    expect(t).toContain('robin V. and Robin V.');
    expect(t).toContain(`<phone:${egress.tokenFor(avery)}>`);
    expect(t).toMatch(/<phone:H\d+>/); // the unresolved number
    expect(t).toContain('<phone:ME>');
    expect(t).toContain('<email>');
    expect(t).toContain(`<ig:${egress.tokenFor(avery)}>`);
    expect(t).toContain('<handle>');
    expect(t).toContain('<addr> in Springfield');
    expect(t).toContain('<num>');
    expect(t).toContain('<link:events.example.com>');
    expect(t).toContain('Acme Corp in Austin');
    // message refs survive (m:1234567 is a ref, not a number)
    expect(t).toContain('[m:8812|2026-10-12 19:04|P1→ME]');
    expect(t).toContain('[m:1234567|2026-10-12 19:05|ME]');
    expect(p.text.startsWith('### window\n')).toBe(true);
    expect(p.tokenMap.ME).toEqual({ kind: 'me', id: me });
    expect(p.tokenMap[egress.tokenFor(avery)]).toEqual({ kind: 'person', id: avery });
    expect(Object.values(p.tokenMap).some((v) => v.kind === 'identity' && v.id === unknown)).toBe(true);
    expect(p.replaced).toMatchObject({ phone: 3, email: 1, handle: 2, addr: 1, num: 1, link: 1, last_name: 3 });
    expect(findRawIdentifiers(p.text)).toEqual([]);
    expect(scanFindings(p.text)).toEqual([]);
    expect(() => egress.scan(p.text)).not.toThrow();
  });

  it('keeps UUIDs and decimals intact; fails closed on an empty packet', () => {
    const { egress } = world();
    const id = '019a0000-0000-7000-8000-000000123456';
    const p = egress.pseudonymize({ purpose: 'ask', sections: [{ name: 'r', text: `ref ${id} ratio 3.1415926 at 07:30` }] });
    expect(p.text).toContain(id);
    expect(p.text).toContain('3.1415926');
    expect(() => egress.pseudonymize({ purpose: 'ask', sections: [] })).toThrow(EgressRefused);
    expect(() => egress.pseudonymize({ purpose: 'ask', sections: [] })).toThrow(EgressBlocked);
  });

  it('scrubs handles written back to back and handles a later step exposes; its output always passes the scanner', () => {
    const { egress, avery } = world();
    const scrub = (text: string) => egress.pseudonymize({ purpose: 'extract', sections: [{ name: 'm', text }] });
    // "@a@b": the second handle follows a letter in the original text, so one pass skipped it (the 2026-10-16 block).
    expect(scrub('follow @trail_mix_42@summit_crew for the route').sections[0]!.text).toBe('follow <handle><handle> for the route');
    expect(scrub('ping @avery.q@someone_new').sections[0]!.text).toBe(`ping <ig:${egress.tokenFor(avery)}><handle>`);
    expect(scrub('@one_a@two.b@three_c / @x_@yz').sections[0]!.text).toBe('<handle><handle><handle> / <handle><handle>');
    // A digit run replaced after the handle pass leaves "<num>@…" behind: caught by the last pass.
    expect(scrub('code 7316402@someone_new').sections[0]!.text).toBe('code <num><handle>');
    const p = scrub('a @trail.mix@summit_crew b @trail_mix_42@summit_crew');
    expect(p.replaced.handle).toBe(4);
    expect(findRawIdentifiers(p.text)).toEqual([]);
    expect(scanFindings(p.text)).toEqual([]);
    expect(() => egress.scan(p.text)).not.toThrow();
  });

  it('without a database nothing can be pseudonymized (fails closed); the scanner still works', () => {
    const closed = createEgress(null);
    expect(() => closed.pseudonymize({ purpose: 'extract', sections: [{ name: 'x', text: 'hi' }] })).toThrow(EgressBlocked);
    expect(() => closed.tokenFor('x')).toThrow(EgressBlocked);
    expect(closed.resolveToken('P1')).toBeNull();
    expect(() => closed.scan('mail owner@example.com')).toThrow(EgressBlocked);
  });
});

describe('tokens', () => {
  it('are stable, global, always contain a digit, and survive merges', () => {
    const { db, egress, avery, robin, me } = world();
    const a = egress.tokenFor(avery);
    expect(a).toMatch(/^P[0-9a-z]*\d[0-9a-z]*$/);
    expect(egress.tokenFor(avery)).toBe(a);
    expect(createEgress(db).tokenFor(avery)).toBe(a); // persisted in `pseudonyms`
    expect(egress.tokenFor(robin)).not.toBe(a);
    expect(egress.tokenFor(me)).toBe('ME');
    expect(egress.resolveToken(a)).toEqual({ kind: 'person', id: avery });
    expect(egress.resolveToken('ME')).toEqual({ kind: 'me', id: me });
    expect(egress.resolveToken('Pizza')).toBeNull();
    // Robin merged into Avery: Robin's token now resolves to the survivor
    const r = egress.tokenFor(robin);
    db.prepare(`UPDATE people SET merged_into_id = ?, status = 'merged' WHERE id = ?`).run(avery, robin);
    expect(createEgress(db).resolveToken(r)).toEqual({ kind: 'person', id: avery });
    expect(createEgress(db).tokenFor(robin)).toBe(a);
  });

  it('base36 ordinals made only of letters are skipped (no "Pa", "Pat", "Pz")', () => {
    expect(nextPersonOrdinal(10)).toBe(36); // a..z skipped → "10"
    expect((370).toString(36)).toBe('aa');
    expect(/\d/.test(nextPersonOrdinal(370).toString(36))).toBe(true);
    for (let n = 1; n < 2000; n = nextPersonOrdinal(n + 1)) expect(n.toString(36)).toMatch(/\d/);
    expect(tokensIn('Pat met P1a and ME, Pizza H3 [P17]')).toEqual(['P1a', 'ME', 'H3', 'P17']);
  });

  it('allocates many tokens without collisions', () => {
    const { db, egress } = world();
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(egress.tokenFor(seedPerson(db, { first_name: `N${i}`, last_name: 'X' })));
    expect(seen.size).toBe(60);
    expect([...seen].every((t) => /\d/.test(t))).toBe(true);
  });
});

describe('detokenize', () => {
  it('turns tokens into first name + last initial locally; unknown tokens stay', () => {
    const { egress, avery, unknown } = world();
    const a = egress.tokenFor(avery);
    const h = (egress as unknown as { identityToken(id: string): string }).identityToken(unknown);
    expect(egress.detokenize(`${a} owes ME a call. ME should text ${h}; P999 is unknown.`, {})).toBe(
      `Avery Q. owes you a call. you should text (212) •••-••77; P999 is unknown.`,
    );
    expect(detokenizeKeepingCitations(egress, `${a} [${a}] likes climbing [m:8812]`)).toBe(`Avery Q. [${a}] likes climbing [m:8812]`);
  });

  it('a person whose only name is a raw identifier never comes back as one', () => {
    const { db, egress } = world();
    const p = seedPerson(db, { first_name: null, last_name: null, display_name: '@raw_handle' });
    expect(egress.detokenize(egress.tokenFor(p), {})).toBe('a contact');
  });

  it('DeltaDetokenizer never splits a token or a citation across deltas', () => {
    const { egress, avery } = world();
    const a = egress.tokenFor(avery);
    const text = `Ask ${a} about it [${a}] and ME.`;
    for (let size = 1; size <= 6; size++) {
      const d = new DeltaDetokenizer(egress);
      let out = '';
      for (let i = 0; i < text.length; i += size) out += d.push(text.slice(i, i + size));
      out += d.flush();
      expect(out).toBe(`Ask Avery Q. about it [${a}] and you.`);
    }
  });

  it('personIdsIn finds the people behind the tokens (exclusion check)', () => {
    const { egress, avery } = world();
    const a = egress.tokenFor(avery);
    expect(personIdsIn(egress, `[m:1|2026-10-12 19:04|${a}→ME] hi`)).toEqual([avery]);
  });
});

describe('scanner', () => {
  it('fails closed on raw phones (every format libphonenumber knows), emails and @handles', () => {
    for (const bad of ['call +1 212 555 0123', 'text (212)5550142', 'uk +44 20 7946 0958', 'mail a@example.com', 'dm @someone', '2125550123']) {
      expect(scanFindings(bad).length, bad).toBeGreaterThan(0);
    }
    for (const ok of ['[m:8812|2026-10-12 19:04|P17→ME] brunch at 11?', 'ids 019a0000-0000-7000-8000-00000000000a', '<phone:P1> <email> <handle>', 'zip 78701']) {
      expect(scanFindings(ok), ok).toEqual([]);
    }
  });

  it('the libphonenumber pre-filter skips date-times, UUIDs and short refs but never a phone shape', () => {
    for (const no of ['[m:123456|2026-10-12 19:04|P1a→ME] see you at 7', '019a0000-0000-7000-8000-000000123456', 'zip 78701, 3.5 stars', '2026-10-12T19:04:00.000Z']) {
      expect(mayHoldPhone(no), no).toBe(false);
    }
    for (const yes of ['(212)5550142', '+44 20 7946 0958', '212 555 0123', '2125550123', '212.555.0123', '2026-10-12 212-555-0123']) expect(mayHoldPhone(yes), yes).toBe(true);
  });

  it('scans only user turns of single and batch request bodies', () => {
    const clean = { system: [{ type: 'text', text: 'Example: sam@example.com' }], messages: [{ role: 'user', content: 'hi P1' }, { role: 'assistant', content: [{ type: 'text', text: 'x@example.com' }] }] };
    expect(() => scanRequestBody(clean)).not.toThrow();
    const toolLeak = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'reach +1 212 555 0123' }] }] };
    expect(() => scanRequestBody(toolLeak)).toThrow(EgressBlocked);
    expect(() => scanRequestBody({ requests: [{ custom_id: 'a', params: { messages: [{ role: 'user', content: 'ok' }] } }, { custom_id: 'b', params: { messages: [{ role: 'user', content: 'x@example.com' }] } }] })).toThrow(
      EgressBlocked,
    );
  });
});

describe('egressFetch (the single way out)', () => {
  const sent: string[] = [];
  const inner = (async (input: string | URL | Request) => {
    sent.push(String(input));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const f = egressFetch({ fetch: inner });

  it('passes allowlisted Anthropic endpoints with clean bodies', async () => {
    sent.length = 0;
    const ok = await f('https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hello P1' }] }) });
    expect(ok.status).toBe(200);
    expect((await f('https://api.anthropic.com/v1/messages/batches/msgbatch_1', { method: 'GET' })).status).toBe(200);
    expect((await f('https://api.anthropic.com/v1/messages/batches/msgbatch_1/results', { method: 'GET' })).status).toBe(200);
    expect(sent).toHaveLength(3);
  });

  it('answers a local 400 (never sent) for raw identifiers, other hosts, other endpoints and non-JSON bodies', async () => {
    sent.length = 0;
    const cases: [string, RequestInit][] = [
      ['https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'mail owner@example.com' }] }) }],
      ['https://evil.example.net/v1/messages', { method: 'POST', body: JSON.stringify({ messages: [] }) }],
      ['https://api.anthropic.com/v1/files', { method: 'POST', body: '{}' }],
      ['https://api.anthropic.com/v1/messages', { method: 'POST', body: 'not json' }],
      ['https://api.anthropic.com/v1/messages', { method: 'DELETE' }],
    ];
    for (const [url, init] of cases) {
      const res = await f(url, init);
      expect(res.status, url).toBe(400);
      expect(res.headers.get(EGRESS_BLOCKED_HEADER)).toBe('blocked');
    }
    expect(sent).toEqual([]);
  });
});
