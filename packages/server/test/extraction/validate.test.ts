/** validateExtraction on hand-built synthetic packets: refs, citations, quotes, plausibility, dates, mentions. */
import { describe, expect, it } from 'vitest';
import type { Packet } from '../../src/extraction/packet';
import { parseExtraction, type Extraction } from '../../src/extraction/schema';
import { validateExtraction } from '../../src/extraction/validate';
import { gateStatus } from '../../src/extraction/apply';
import { extraction, fact } from './world';

const TZ = 'America/Chicago';
// Sunday 2026-03-08, 18:00 local (CDT from that morning: UTC−5).
const AT = Date.UTC(2026, 2, 8, 23, 0);

function packet(over: Partial<Packet> = {}): Packet {
  return {
    v: 1,
    windowId: 'w1',
    conversationId: 'c1',
    mode: 'steady',
    chat: 'group',
    memberCount: 4,
    asOf: Date.UTC(2026, 2, 9, 5),
    tz: TZ,
    meId: 'me',
    dmCounterpart: null,
    lines: [
      { n: 1, msgId: 101, role: 'context', at: AT - 3600_000, author: 'P1', authorPersonId: 'sam', identityId: 'i-sam', body: 'I adore jazz piano, been playing for years' },
      { n: 2, msgId: 102, role: 'new', at: AT, author: 'P1', authorPersonId: 'sam', identityId: 'i-sam', body: 'dinner thursday? I also started pottery' },
      { n: 3, msgId: 103, role: 'new', at: AT + 60_000, author: 'P2', authorPersonId: 'lee', identityId: 'i-lee', body: 'Sam is the best cook I know, also my sister Ana just moved to Lisbon' },
      { n: 4, msgId: 104, role: 'new', at: AT + 120_000, author: 'ME', authorPersonId: null, identityId: null, body: 'I am vegetarian now btw, and sure, dinner works' },
    ],
    refs: {
      P1: { personId: 'sam', role: 'participant', firstName: 'Sam' },
      P2: { personId: 'lee', role: 'participant', firstName: 'Lee' },
      P3: { personId: 'ana1', role: 'mentionable', firstName: 'Ana' },
      P4: { personId: 'ana2', role: 'mentionable', firstName: 'Ana' },
    },
    facts: { F1: { factId: 'fact-1', personId: 'sam', cat: 'interest', valueNorm: 'cooking' } },
    commitments: { K1: { commitmentId: 'k-1', personId: 'sam' } },
    ...over,
  };
}

const run = (x: Record<string, unknown>, p = packet()) => validateExtraction(x as Extraction, p, { now: AT });

describe('validateExtraction', () => {
  it('drops CONTEXT-only items, bad quotes and unknown refs; keeps NEW-cited facts', () => {
    const v = run(
      extraction({
        facts: [
          fact('P1', 'interest', 'jazz piano', [{ msg: 'm:1', quote: 'I adore jazz piano' }]),
          fact('P1', 'interest', 'pottery', [{ msg: 'm:2', quote: 'I also started pottery' }]),
          fact('P1', 'interest', 'knitting', [{ msg: 'm:2', quote: 'I also started knitting' }]),
          fact('P9', 'interest', 'chess', [{ msg: 'm:2', quote: 'dinner thursday?' }]),
          fact('P1', 'interest', 'pottery', [{ msg: 'm:77', quote: 'dinner thursday?' }]),
        ],
      }),
    );
    expect(v.facts.map((f) => f.value)).toEqual(['pottery']);
    expect(v.dropped).toMatchObject({ fact_no_new_evidence: 3, ev_quote: 1, fact_bad_subject: 1, ev_bad_msg: 1 });
  });

  it('ME facts need ME to state them; the subject must be plausible (else −0.2)', () => {
    const v = run(
      extraction({
        facts: [
          fact('ME', 'food_drink', 'vegetarian', [{ msg: 'm:4', quote: 'I am vegetarian now' }], 0.9),
          fact('ME', 'interest', 'cooking', [{ msg: 'm:3', quote: 'the best cook I know' }], 0.9),
          // Lee's line names Sam: plausible. A fact about Lee from Sam's line that doesn't name Lee: penalized.
          fact('P1', 'interest', 'cooking', [{ msg: 'm:3', quote: 'Sam is the best cook I know' }], 0.8, { op: 'NOOP', target: 'F1' }),
          fact('P2', 'interest', 'pottery', [{ msg: 'm:2', quote: 'I also started pottery' }], 0.8),
        ],
      }),
    );
    expect(v.facts.map((f) => [f.personId, f.value, f.conf])).toEqual([
      ['me', 'vegetarian', 0.9],
      ['sam', 'cooking', 0.8],
      ['lee', 'pottery', expect.closeTo(0.6, 5)],
    ]);
    expect(v.facts[1]!.targetFactId).toBe('fact-1');
    expect(v.dropped.fact_me_not_stated).toBe(1);
  });

  it('targets must exist, belong to the subject and match the category', () => {
    const v = run(
      extraction({
        facts: [
          fact('P2', 'interest', 'cooking', [{ msg: 'm:3', quote: 'best cook' }], 0.9, { op: 'NOOP', target: 'F1' }),
          fact('P1', 'food_drink', 'cooking', [{ msg: 'm:2', quote: 'dinner thursday?' }], 0.9, { op: 'UPDATE', target: 'F1' }),
          fact('P1', 'interest', 'cooking', [{ msg: 'm:2', quote: 'dinner thursday?' }], 0.9, { op: 'INVALIDATE', target: 'F7' }),
        ],
      }),
    );
    expect(v.facts).toEqual([]);
    expect(v.dropped.fact_bad_target).toBe(3);
  });

  it('mentions: a unique resolution applies (via mention), an ambiguous or unresolved one is held', () => {
    const v = run(
      extraction({
        facts: [
          fact('M1', 'location_current', 'Lisbon', [{ msg: 'm:3', quote: 'my sister Ana just moved to Lisbon' }], 0.9),
          fact('M2', 'location_current', 'Lisbon', [{ msg: 'm:3', quote: 'just moved to Lisbon' }], 0.9),
        ],
        mentions: [
          { id: 'M1', surface: 'Ana', msg: 'm:3', resolved: 'P3', candidates: ['P4'], descriptor: "P2's sister" },
          { id: 'M2', surface: 'my sister', msg: 'm:3', resolved: null, candidates: [], descriptor: null },
        ],
      }),
    );
    expect(v.facts).toEqual([]);
    expect(v.pending.map((p) => [p.surface, p.candidates])).toEqual([
      ['Ana', ['ana2']],
      ['my sister', []],
    ]);
    const v2 = run(
      extraction({
        facts: [fact('M1', 'location_current', 'Lisbon', [{ msg: 'm:3', quote: 'Ana just moved to Lisbon' }], 0.9)],
        mentions: [{ id: 'M1', surface: 'Ana', msg: 'm:3', resolved: 'P3', candidates: [], descriptor: null }],
      }),
    );
    expect(v2.facts.map((f) => [f.personId, f.viaMention])).toEqual([['ana1', true]]);
  });

  it('place facts become place names; an ADD or UPDATE that names no single city is dropped', () => {
    const ev = [{ msg: 'm:3', quote: 'Ana just moved to Lisbon' }];
    const v = run(
      extraction({
        facts: [
          fact('P3', 'location_current', 'Lisbon', ev),
          fact('P3', 'hometown', 'LA', ev),
          fact('P3', 'location_next', 'lives with her sister', ev),
          fact('P3', 'location_current', 'Portugal', ev),
          fact('P3', 'location_current', 'Lisbon or Porto', ev),
          // INVALIDATE only points at the card's fact: its repeated value can stay as written
          fact('P1', 'location_current', 'Bay Area', [{ msg: 'm:2', quote: 'dinner thursday?' }], 0.9, { op: 'INVALIDATE', target: 'F2' }),
          fact('P3', 'travel_plan', 'Lisbon trip', ev),
        ],
      }),
      packet({ facts: { F2: { factId: 'fact-2', personId: 'sam', cat: 'location_current', valueNorm: 'bay area' } } }),
    );
    expect(v.facts.map((f) => [f.cat, f.value, f.valueNorm])).toEqual([
      ['location_current', 'Lisbon, Portugal', 'lisbon portugal'],
      ['hometown', 'Los Angeles, CA', 'los angeles ca'],
      ['location_current', 'Bay Area', 'bay area'],
      ['travel_plan', 'Lisbon trip', 'lisbon trip'],
    ]);
    expect(v.dropped.fact_not_a_place).toBe(3);
  });

  it('commitment dates: chrono on the quote wins when the model is >2 days off; closes needs a K of the counterpart', () => {
    const c = (over: Record<string, unknown>) => ({
      owner: 'BOTH',
      with: ['P1'],
      kind: 'meet',
      what: 'dinner',
      due: { kind: 'date', start: '2026-03-20', end: null },
      status: 'open',
      closes: null,
      ev: [{ msg: 'm:2', quote: 'dinner thursday?' }],
      conf: 0.8,
      ...over,
    });
    const v = run(
      extraction({
        commitments: [
          c({}),
          c({ due: { kind: 'date', start: '2026-03-01', end: null }, ev: [{ msg: 'm:4', quote: 'sure, dinner works' }] }),
          c({ status: 'done', closes: 'K1' }),
          c({ status: 'done', closes: 'K9' }),
          c({ conf: 0.6 }),
        ],
      }),
    );
    expect(v.commitments).toHaveLength(3);
    const [first, second, third] = v.commitments;
    expect(first).toMatchObject({ personId: 'sam', duePrecision: 'date', dateCorrected: true, dueStart: Date.UTC(2026, 2, 12, 5) });
    expect(second).toMatchObject({ duePrecision: 'vague', dueStart: null });
    expect(third).toMatchObject({ status: 'done', closesCommitmentId: 'k-1' });
    expect(v.dropped).toMatchObject({ commitment_bad_close: 1, commitment_low_conf: 1 });
  });

  it('needs_reply must name an inbound NEW message; n_a is kept as a verdict through the last NEW line', () => {
    expect(run(extraction({ needs_reply: { state: 'needs_reply', msg: 'm:4', reason: 'question', urgency: 'high', conf: 0.9 } })).needsReply).toBeNull();
    expect(run(extraction({ needs_reply: { state: 'needs_reply', msg: 'm:3', reason: null, urgency: 'high', conf: 0.9 } })).needsReply).toEqual({
      messageId: 103,
      throughMsgId: 104,
      state: 'needs_reply',
      reason: 'other',
      urgency: 'high',
      conf: 0.9,
    });
    expect(run(extraction()).needsReply).toMatchObject({ state: 'n_a', messageId: null, throughMsgId: 104 });
  });

  it('historical: ADD only, and obligations older than 30 days are dropped', () => {
    const p = packet({ mode: 'historical', asOf: AT + 90 * 86_400_000 });
    const v = run(
      extraction({
        facts: [
          fact('P1', 'interest', 'pottery', [{ msg: 'm:2', quote: 'started pottery' }]),
          fact('P1', 'interest', 'cooking', [{ msg: 'm:3', quote: 'best cook' }], 0.9, { op: 'NOOP', target: 'F1' }),
        ],
        commitments: [
          {
            owner: 'BOTH',
            with: ['P1'],
            kind: 'meet',
            what: 'dinner',
            due: { kind: 'none', start: null, end: null },
            status: 'open',
            closes: null,
            ev: [{ msg: 'm:2', quote: 'dinner thursday?' }],
            conf: 0.9,
          },
        ],
        needs_reply: { state: 'needs_reply', msg: 'm:3', reason: 'question', urgency: 'normal', conf: 0.9 },
        relations: [{ op: 'INVALIDATE', a: 'P1', b: 'P2', label: 'friend', sensitive: false, ev: [{ msg: 'm:3', quote: 'Sam is the best' }], conf: 0.9 }],
      }),
      p,
    );
    expect(v.facts.map((f) => f.value)).toEqual(['pottery']);
    expect(v.commitments).toEqual([]);
    expect(v.needsReply).toBeNull();
    expect(v.relations).toEqual([]);
    expect(v.dropped).toMatchObject({ fact_historical_op: 1, commitment_too_old: 1, relation_historical_op: 1 });
  });

  it('relations: gates (ex ≥0.90, always sensitive); self-ids need the person’s own line', () => {
    const rel = (label: string, conf: number) => ({ op: 'ADD', a: 'P1', b: 'P2', label, sensitive: false, ev: [{ msg: 'm:3', quote: 'Sam is the best cook' }], conf });
    const v = run(
      extraction({
        relations: [rel('friend', 0.9), rel('ex', 0.88), rel('ex', 0.95), rel('coworker', 0.8)],
        self_id: [
          { ref: 'P2', name: 'Lee', context: null, basis: 'self_stated', ev: [{ msg: 'm:3', quote: 'Sam is the best cook' }], conf: 0.9 },
          { ref: 'P1', name: 'Lee', context: null, basis: 'self_stated', ev: [{ msg: 'm:3', quote: 'Sam is the best cook' }], conf: 0.9 },
        ],
      }),
    );
    expect(v.relations.map((r) => [r.label, r.sensitive])).toEqual([
      ['friend', false],
      ['ex', true],
    ]);
    expect(v.selfIds.map((s) => [s.personId, s.identityId])).toEqual([['lee', 'i-lee']]);
    expect(v.dropped).toMatchObject({ relation_low_conf: 2, self_id_no_identity: 1 });
  });
});

describe('enums (parseExtraction): an out-of-set value costs its item, not the window', () => {
  const commitment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    owner: 'BOTH',
    with: ['P1'],
    kind: 'meet',
    what: 'dinner Thursday',
    due: { kind: 'vague', start: null, end: null },
    status: 'open',
    closes: null,
    ev: [{ msg: 'm:4', quote: 'sure, dinner works' }],
    conf: 0.9,
    ...over,
  });
  const relation = (label: string) => ({ op: 'ADD', a: 'P2', b: 'P1', label, sensitive: false, ev: [{ msg: 'm:3', quote: 'Sam is the best cook I know' }], conf: 0.9 });

  it('drops each item holding a string outside its set, counts it, and validates the rest', () => {
    const parsed = parseExtraction(
      extraction({
        facts: [fact('P1', 'interest', 'pottery', [{ msg: 'm:2', quote: 'I also started pottery' }]), fact('P1', 'hobby', 'pottery', [{ msg: 'm:2', quote: 'I also started pottery' }])],
        // A person token as owner and a kind "text" (seen in production 2026-10-18); two bad fields are one item.
        commitments: [commitment(), commitment({ owner: 'P66' }), commitment({ kind: 'text', due: { kind: 'someday', start: null, end: null } })],
        relations: [relation('friend'), relation('bestie')],
        needs_reply: { state: 'needs_reply', msg: 'm:2', reason: 'invite', urgency: 'normal', conf: 0.9 },
      }),
    );
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.dropped).toEqual({ fact_bad_enum: 1, commitment_bad_enum: 2, relation_bad_enum: 1, needs_reply_bad_enum: 1 });
    expect(parsed.data.commitments.map((c) => [c.owner, c.kind])).toEqual([['BOTH', 'meet']]);
    expect(parsed.data.needs_reply).toBeNull();
    const v = validateExtraction(parsed.data, packet(), { now: AT });
    expect(v.facts.map((f) => [f.personId, f.value])).toEqual([['sam', 'pottery']]);
    expect(v.commitments.map((c) => [c.personId, c.owner, c.kind])).toEqual([['sam', 'both', 'meet']]);
    expect(v.relations.map((r) => r.label)).toEqual(['friend']);
    // The dropped verdict is no verdict (not n_a, which would be recorded).
    expect(v.needsReply).toBeNull();
    expect(v.dropped).toEqual({ fact_bad_enum: 1, commitment_bad_enum: 2, relation_bad_enum: 1, needs_reply_bad_enum: 1 });
  });

  it('stakes: the label reaches the validated commitment; an answer from before stakes reads normal; "huge" costs the item', () => {
    const parsed = parseExtraction(
      extraction({ commitments: [commitment({ stakes: 'low', what: 'bring tomatoes' }), commitment({ stakes: 'high' }), commitment(), commitment({ stakes: 'huge' })] }),
    );
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.dropped).toEqual({ commitment_bad_enum: 1 });
    const v = validateExtraction(parsed.data, packet(), { now: AT });
    expect(v.commitments.map((c) => [c.what, c.stakes])).toEqual([
      ['bring tomatoes', 'low'],
      ['dinner Thursday', 'high'],
      ['dinner Thursday', 'normal'],
    ]);
  });

  it('a clean answer passes as is (nothing dropped)', () => {
    const parsed = parseExtraction(extraction({ commitments: [commitment()] }));
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.dropped).toBeUndefined();
    expect(validateExtraction(parsed.data, packet(), { now: AT }).dropped).toEqual({});
  });

  it('structure stays strict: a missing key or a wrong type fails the window, also next to an enum mismatch', () => {
    const { owner: _, ...ownerless } = commitment();
    for (const bad of [
      extraction({ commitments: [ownerless] }),
      extraction({ commitments: [commitment({ owner: 3 })] }),
      extraction({ commitments: [commitment({ owner: null })] }),
      extraction({ commitments: [commitment({ owner: 'P66' }), commitment({ conf: 'high' })] }),
      extraction({ facts: [fact('P1', 'hobby', 'pottery', [{ msg: 'm:2', quote: 'pottery' }], 0.9, { ev: 'm:2' })] }),
      extraction({ needs_reply: { state: 'maybe' } }),
      extraction({ facts: 'none' }),
      { ...extraction(), topics: undefined },
      null,
    ]) {
      expect(parseExtraction(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('gates', () => {
  it('interests need ≥0.85 with ≥2 messages (or ≥0.75 across ≥2 days); other facts ≥0.80', () => {
    expect(gateStatus('interest', 0.95, 1, 1)).toBe('candidate');
    expect(gateStatus('interest', 0.86, 2, 1)).toBe('tentative');
    expect(gateStatus('interest', 0.9, 2, 1)).toBe('confirmed');
    expect(gateStatus('interest', 0.78, 2, 2)).toBe('confirmed');
    expect(gateStatus('interest', 0.78, 2, 1)).toBe('candidate');
    expect(gateStatus('interest', 0.4, 5, 5)).toBeNull();
    expect(gateStatus('location_current', 0.82, 1, 1)).toBe('tentative');
    expect(gateStatus('location_current', 0.92, 1, 1)).toBe('confirmed');
    expect(gateStatus('location_current', 0.7, 1, 1)).toBe('candidate');
    expect(gateStatus('location_current', 0.7, 2, 2)).toBe('tentative');
    expect(gateStatus('other', 0.82, 1, 1)).toBe('candidate');
    // People who are only mentioned: at least 0.80.
    expect(gateStatus('location_current', 0.79, 1, 1, true)).toBe('candidate');
  });
});
