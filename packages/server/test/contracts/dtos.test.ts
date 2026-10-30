/**
 * Contract round-trips: a synthetic, fully-populated payload for every agent-loop DTO (and the ticket, Gmail and
 * Google Photos ones) parses back to itself (so no field is silently stripped or renamed), and the key validation
 * rules hold. All data is invented.
 */
import { describe, expect, it } from 'vitest';
import {
  AlertList,
  AskConversation,
  AskConversationList,
  AskEvent,
  AskRequest,
  CollectionCreate,
  CollectionDetail,
  CollectionMembershipEdit,
  CollectionMembersEdit,
  Connections,
  DigestPreview,
  DigestSendTest,
  encodeSseEvent,
  EvalItemPage,
  EvalLabelInput,
  EvalReport,
  EventBrief,
  GmailDisconnectResult,
  GmailStatus,
  GoogleProductDisconnect,
  GphotosDisconnectResult,
  GphotosSessionStart,
  GphotosSessionView,
  GphotosStatus,
  LearnerReset,
  LearnerState,
  LoopAction,
  MergeHistory,
  MetAtList,
  NetworkGraph,
  NetworkQuery,
  NoteCreate,
  OpenLoopList,
  PairView,
  PersonCollections,
  PersonFacts,
  PushPayload,
  PushSubscribe,
  SettingsPatch,
  SseParser,
  Starters,
  SuggestionFeedback,
  SuggestionFeedbackResult,
  TicketList,
  TicketsQuery,
  TieStats,
  TodayResponse,
  TripsResponse,
  WhyThis,
  type AskCitation,
  type AskEvent as AskEventT,
  type AskTurn,
  type DigestItem,
  type EdgeLabelView,
  type EvalLabel,
  type FactView,
  type EvidenceRef,
  type OpenLoop,
  type PersonChip,
} from '@yb/shared';
import type { z } from 'zod';

const T = Date.UTC(2026, 9, 14, 15, 0, 0);
const A = '019a0000-0000-7000-8000-00000000000a';
const B = '019a0000-0000-7000-8000-00000000000b';
const C = '019a0000-0000-7000-8000-00000000000c';

const chip = (id: string, name: string): PersonChip => ({ id, displayName: name, firstName: name.split(' ')[0]!, state: 'steady' });
const ev: EvidenceRef = { kind: 'message', ref: 'm:8812', label: 'iMessage · Oct 3', at: T, quote: 'brunch at 11?', source: 'imessage', href: `/p/${A}?m=8812` };

const item: DigestItem = {
  suggestionId: C,
  ordinal: 1,
  kind: 'reply_debt',
  isWildcard: false,
  wildcardGenerator: null,
  people: [chip(A, 'Avery Quill')],
  headline: 'Reply to Avery Q. — asked about Sat brunch (2d)',
  body: null,
  openers: ['Sat works! 11?'],
  sensitive: false,
  status: 'delivered',
  snoozedUntil: null,
  deliveredAt: T,
  expiresAt: null,
  timeCritical: false,
  copy: 'template',
  target: { type: 'person', id: A, otherId: null, href: `/p/${A}` },
  evidence: [ev],
  actions: ['done', 'snooze', 'skip', 'wrong', 'why'],
};

const loop: OpenLoop = {
  type: 'commitment',
  id: C,
  person: chip(A, 'Avery Quill'),
  otherPeople: [],
  title: 'Send the gym link',
  detail: null,
  since: T,
  due: { precision: 'date', start: T, end: T },
  owner: 'me',
  status: 'open',
  likely: false,
  urgency: null,
  confidence: 0.82,
  conversationId: null,
  evidence: [ev],
};

/** parse(x) must equal x: nothing dropped, nothing renamed. */
function roundTrip<S extends z.ZodType>(schema: S, value: z.input<S>) {
  expect(schema.parse(value)).toEqual(value);
}

describe('agent-loop DTO round-trips', () => {
  it('today, suggestions, why, feedback', () => {
    roundTrip(TodayResponse, {
      date: '2026-10-14',
      generatedAt: T,
      digest: {
        id: C,
        localDate: '2026-10-14',
        status: 'sent',
        itemCap: 4,
        composedAt: T,
        sentAt: T,
        pushSentAt: null,
        imessage: 'sent',
        push: 'disabled',
        skipReason: null,
      },
      items: [item, { ...item, ordinal: 2, kind: 'wildcard', isWildcard: true, wildcardGenerator: 'memory', copy: 'llm' }],
      allClear: false,
      openLoops: { counts: { replyDebts: 2, commitments: 1, waitingOn: 0 }, preview: [loop] },
      checkThese: [
        {
          batch: {
            id: B,
            seq: 7,
            kind: 'merge',
            title: 'Merged two records',
            subjectPersonId: A,
            confidence: 0.91,
            actor: 'agent',
            undoable: true,
            createdAt: T,
            undoneAt: null,
            undoneByBatchId: null,
            revertsBatchId: null,
            changeCount: 3,
          },
          reason: 'Name + 2 shared groups (p 0.91)',
        },
      ],
      alerts: [{ id: B, source: 'whatsapp', severity: 'warning', message: 'WhatsApp quiet 4d', openedAt: T, lastNotifiedAt: null, resolvedAt: null, href: '/sources' }],
      activity: {
        lastRun: { id: B, kind: 'nightly', status: 'ok', startedAt: T, finishedAt: T, changeCount: 23 },
        last24h: { merges: 2, links: 4, facts: 11, edges: 0, circles: 0, other: 6 },
        line: 'Last night: 2 merges · 4 IG links · 11 facts',
      },
    });
    roundTrip(WhyThis, {
      suggestionId: C,
      kind: 'fading',
      summary: 'Quiet 41 days; usually every ~9 days.',
      base: 0.6,
      score: 0.52,
      factors: [{ arm: 'kind', label: 'Fading overall', value: 0.9, propensity: 0.45, n: 12 }],
      signals: [{ label: 'Silence', value: '41 days' }],
      evidence: [ev],
      adjustments: [{ label: 'Priority', value: '×1.3' }],
    });
    for (const fb of [
      { action: 'done' },
      { action: 'snooze', until: T },
      { action: 'skip' },
      { action: 'wrong', note: 'not a question' },
      { action: 'why' },
      { action: 'draft' },
      { action: 'open' },
      { action: 'mute', scope: 'person_kind' },
    ] as const) {
      roundTrip(SuggestionFeedback, fb);
    }
    expect(SuggestionFeedback.safeParse({ action: 'snooze' }).success).toBe(false);
    expect(SuggestionFeedback.safeParse({ action: 'send' }).success).toBe(false);
    roundTrip(SuggestionFeedbackResult, { suggestionId: C, status: 'done', batchId: null, why: null, openers: null });
  });

  it('learner state and resets', () => {
    roundTrip(LearnerState, {
      kinds: [{ kind: 'reply_debt', alpha: 6.5, beta: 2.2, propensity: 0.75, trend: 'up', trendDelta: 0.08, shown30d: 9, acted30d: 6, muted: false }],
      wildcard: {
        epsilon: 0.2,
        hitRate: 0.25,
        shown: 4,
        acted: 1,
        lastShownDate: '2026-10-12',
        generators: [{ generator: 'dormant_close', propensity: 0.5, shown: 2, acted: 1 }],
      },
      mutedPeople: [{ person: chip(A, 'Avery Quill'), kinds: ['fading'], since: T }],
      cooledPeople: [{ person: chip(B, 'Blake Ruin'), cooldownUntil: T, consecutiveIgnores: 2 }],
      adaptiveCap: { current: 4, lateActRate: null },
      updatedAt: T,
    });
    roundTrip(LearnerReset, { scope: 'kind', kind: 'fading' });
    expect(LearnerReset.safeParse({ scope: 'kind' }).success).toBe(false);
  });

  it('person extensions and the pair page', () => {
    roundTrip(TieStats, {
      personId: A,
      state: 'fading',
      label: 'Fading',
      tieStrength: 34,
      historicalStrength: 71,
      closeness: 6,
      expectedGapD: 9,
      silenceD: 41,
      fadingRatio: 4.5,
      momentum: -1.2,
      reciprocity: 0.64,
      iStartShare: 0.82,
      contactDays365: 40,
      lastAt: T,
      fadingSuppressed: false,
      sparkline: [{ date: '2026-10-05', t: 41, units: 2.5 }],
      computedAt: T,
    });
    const fact: FactView = {
      id: 'F1',
      type: 'location_current',
      value: 'Springfield',
      status: 'confirmed',
      sensitive: false,
      confidence: 0.9,
      support: 2,
      validFrom: T,
      validTo: null,
      recordedAt: T,
      retractedAt: null,
      source: 'llm',
      evidence: [ev],
    };
    roundTrip(PersonFacts, { active: [fact], history: [{ ...fact, status: 'invalidated', retractedAt: T }] });
    roundTrip(Starters, { starters: [{ text: 'How was the move?', basis: [ev], source: 'template' }], generatedAt: T, neverSent: true });
    expect(Starters.safeParse({ starters: [], generatedAt: null, neverSent: false }).success).toBe(false);
    roundTrip(OpenLoopList, { replyDebts: [{ ...loop, type: 'reply_debt', likely: true }], commitments: [loop], waitingOn: [], nextCursor: null });
    roundTrip(LoopAction, { action: 'snooze', until: T });
    const chips = [{ type: 'co_group', text: '11 shared group chats', count: 11, latest: ev, wrongable: true }];
    const label: EdgeLabelView = { id: B, label: 'roommate', confidence: 0.9, origin: 'llm', evidence: [ev] };
    roundTrip(Connections, {
      personId: A,
      edges: [{ person: chip(B, 'Blake Ruin'), strength: 0.8, tier: 'close', dominantType: 'co_group', label, chips, lastAt: T }],
      among: [{ a: A, b: B, strength: 0.3 }],
    });
    roundTrip(NoteCreate, { content: 'Likes trail running' });
    expect(NoteCreate.safeParse({ content: '   ' }).success).toBe(false);
    roundTrip(MergeHistory, {
      merges: [
        {
          id: C,
          merged: { id: B, displayName: 'Avery Q' },
          method: 'probabilistic',
          score: 0.991,
          reasons: ['IG handle ⊇ name', '2 shared groups'],
          batchId: B,
          createdAt: T,
          undoneAt: null,
          canSplit: true,
        },
      ],
    });
    const circle = { type: 'circle', id: C, name: 'Climbing crew', kind: 'auto', color: null, icon: null } as const;
    roundTrip(PersonCollections, { circles: [{ ...circle, origin: 'auto' }], tags: [], locations: [] });
    expect(
      CollectionMembershipEdit.parse({ add: [{ type: 'tag', name: 'climbers' }, { type: 'circle', id: C }], remove: [{ type: 'location', id: B }] }),
    ).toEqual({ add: [{ type: 'tag', name: 'climbers' }, { type: 'circle', id: C }], remove: [{ type: 'location', id: B }] });
    expect(CollectionMembershipEdit.safeParse({ add: [{ type: 'tag' }] }).success).toBe(false);
    roundTrip(PairView, {
      a: chip(A, 'Avery Quill'),
      b: chip(B, 'Blake Ruin'),
      strength: 0.8,
      tier: 'close',
      weight: 3.2,
      label,
      chips,
      sharedCircles: { both: [circle], onlyA: [], onlyB: [] },
      timeline: [{ type: 'co_attend', at: T, title: 'Friendsgiving', quote: null, ref: { ...ev, kind: 'event', ref: 'E12' } }],
      batchIds: [B],
    });
  });

  it('network, circles, alerts', () => {
    roundTrip(NetworkGraph, {
      nodes: [
        {
          id: A,
          label: 'Avery Quill',
          firstName: 'Avery',
          tieStrength: 70,
          state: 'strong',
          circleIds: [C],
          primaryCircleId: C,
          degree: 3,
          isMe: false,
          x: null,
          y: null,
        },
      ],
      edges: [{ a: A, b: B, strength: 0.5, weight: 1.4, tier: 'know', dominantType: 'co_group', types: ['co_group', 'co_attend'] }],
      circles: [{ id: C, name: 'Climbing crew', kind: 'auto', color: '#aa8800', icon: null, size: 8 }],
      edgeTypes: ['co_group', 'co_attend'],
      generatedAt: T,
      truncated: false,
    });
    expect(NetworkQuery.parse({ types: 'co_group, co_attend', minStrength: '0.3', includeMe: '1' })).toEqual({
      types: ['co_group', 'co_attend'],
      minStrength: 0.3,
      window: '1y',
      includeMe: true,
      limit: 1500,
    });
    expect(NetworkQuery.parse({})).toEqual({ minStrength: 0.15, window: '1y', limit: 1500 });
    roundTrip(CollectionDetail, {
      collection: {
        type: 'circle',
        id: C,
        name: 'Climbing crew',
        kind: 'auto',
        description: 'Weekend climbing group',
        color: null,
        icon: '🧗',
        memberCount: 2,
        locked: false,
        status: 'active',
        updatedAt: T,
      },
      members: [{ person: chip(A, 'Avery Quill'), origin: 'auto', score: 0.7, addedAt: T }],
      suggestedAdditions: [{ person: chip(B, 'Blake Ruin'), score: 0.45, reason: '3 shared group chats' }],
      facets: { circles: [], tags: [{ id: B, name: 'climbers', count: 2 }], locations: [] },
      fromFacts: [],
      lastActivityAt: null,
    });
    expect(CollectionCreate.parse({ name: ' Book club ' })).toEqual({ name: 'Book club', memberIds: [] });
    expect(CollectionMembersEdit.parse({})).toEqual({ add: [], remove: [] });
    roundTrip(AlertList, { alerts: [] });
  });

  it('ask: requests, events, conversations; SSE framing survives arbitrary chunking', () => {
    roundTrip(AskRequest, { question: 'who do I know in Springfield?' });
    expect(AskRequest.safeParse({ question: '  ' }).success).toBe(false);
    const citation: AskCitation = { ref: 'm:8812', kind: 'message', label: 'Avery · iMessage Oct 3', href: `/p/${A}?m=8812`, at: T };
    const events: AskEventT[] = [
      { type: 'start', conversationId: C, turnId: B },
      { type: 'tool_status', tool: 'search_people', status: 'running', summary: 'Searching people in Springfield', count: null },
      { type: 'tool_status', tool: 'search_people', status: 'done', summary: 'Found 2 people', count: 2 },
      { type: 'delta', text: 'Avery lives there [m:8812]. ' },
      { type: 'citation', citation },
      { type: 'done', conversationId: C, turnId: B, answer: 'Avery lives there [m:8812].', citations: [citation], people: [chip(A, 'Avery Quill')], degraded: false, usage: null },
      { type: 'error', code: 'LLM_UNAVAILABLE', message: 'Answering from search only.' },
    ];
    for (const e of events) roundTrip(AskEvent, e);
    const wire = events.map(encodeSseEvent).join('') + ': keep-alive\n\n' + 'data: {"type":"bogus"}\n\n';
    expect(wire.startsWith('event: start\ndata: {')).toBe(true);
    for (const size of [1, 7, 64, wire.length]) {
      const parser = new SseParser();
      const got: AskEventT[] = [];
      for (let i = 0; i < wire.length; i += size) got.push(...parser.push(wire.slice(i, i + size)));
      expect(got).toEqual(events);
    }
    const turn: AskTurn = { id: B, question: 'q?', answer: 'a', citations: [citation], people: [], channel: 'web', status: 'done', createdAt: T };
    roundTrip(AskConversation, { id: C, title: 'Springfield', turns: [turn], createdAt: T, updatedAt: T });
    roundTrip(AskConversationList, { conversations: [{ id: C, title: 'Springfield', turnCount: 1, createdAt: T, updatedAt: T }], nextCursor: null, suggestedPrompts: ['Who do I know in Springfield?'] });
  });

  it('push: https endpoints only; payload urls are relative paths', () => {
    roundTrip(PushSubscribe, { endpoint: 'https://push.example.com/abc', expirationTime: null, keys: { p256dh: 'BPk', auth: 'au' }, userAgent: 'iPhone' });
    expect(PushSubscribe.safeParse({ endpoint: 'http://push.example.com/abc', keys: { p256dh: 'x', auth: 'y' } }).success).toBe(false);
    roundTrip(PushPayload, { kind: 'digest', title: 'Yeackbot', body: 'Your brief is ready · 4 things', url: '/today', tag: 'digest' });
    expect(PushPayload.safeParse({ kind: 'digest', title: 'Yeackbot', body: 'x', url: 'https://example.com/' }).success).toBe(false);
    expect(PushPayload.safeParse({ kind: 'digest', title: 'Yeackbot', body: 'x', url: '//example.com/x' }).success).toBe(false);
  });

  it('eval, digest, intel', () => {
    const label: EvalLabel = { verdicts: [{ predictionId: 'p1', verdict: 'correct' }], missing: [], note: null, labeledAt: T };
    roundTrip(EvalItemPage, {
      items: [
        {
          id: C,
          set: 'extraction',
          title: 'Window 1k8z',
          lines: [{ ref: 'm:8812', at: T, author: 'P1', text: 'moving to Springfield in March', context: false }],
          predictions: [{ id: 'p1', kind: 'fact', label: 'location_next: Springfield', detail: null, refs: ['m:8812'] }],
          expectedPersonIds: [],
          label,
          promptVersion: 'a3f9c21b',
          createdAt: T,
        },
      ],
      nextCursor: null,
      counts: [{ set: 'extraction', total: 100, labeled: 1, target: 100 }],
    });
    expect(EvalLabelInput.parse({ itemId: C, verdicts: [] })).toEqual({ itemId: C, verdicts: [], missing: [] });
    roundTrip(EvalReport, {
      generatedAt: T,
      sets: [{ set: 'extraction', labeled: 1, metrics: [{ name: 'precision.interest', value: 1, target: 0.85, higherIsBetter: true, pass: true, n: 1 }] }],
      online: [],
      promptVersions: ['a3f9c21b'],
    });
    roundTrip(DigestPreview, {
      date: '2026-10-14',
      texts: ['\u{1F168} Good morning! Just one thing today.\n\n1. Reply to Avery Q.\nAvery asked about Saturday brunch 2 days ago.\n\nyeackbot.com/today'],
      text: '\u{1F168} Good morning! Just one thing today.\n\n1. Reply to Avery Q.\nAvery asked about Saturday brunch 2 days ago.\n\nyeackbot.com/today',
      pushBody: 'Your brief is ready · 1 thing',
      items: [item],
      composer: 'template',
      wouldSend: false,
      reasonNotSent: 'disabled',
      charCount: 80,
    });
    expect(DigestSendTest.safeParse({}).success).toBe(false);
    expect(DigestSendTest.parse({ confirm: true })).toEqual({ confirm: true, mode: 'hello' });
    roundTrip(EventBrief, {
      id: C,
      type: 'occasion',
      title: 'Dinner',
      kind: 'social',
      startsAt: T,
      endsAt: null,
      venue: 'Cafe Example',
      attendees: [
        {
          person: chip(A, 'Avery Quill'),
          tieStrength: 60,
          lastContactAt: T,
          status: 'companion',
          confidence: 0.8,
          openLoops: [loop],
          recentFact: { id: 'F1', type: 'interest', value: 'bouldering' },
        },
      ],
      unknownGuests: ['Guest One'],
      connectors: [{ person: chip(B, 'Blake Ruin'), knows: [chip(A, 'Avery Quill')] }],
      followUp: { status: 'pending', suggestionId: null },
      composer: 'template',
      generatedAt: T,
    });
    roundTrip(TripsResponse, {
      trips: [
        {
          id: C,
          label: 'Springfield',
          geoKey: 'us:springfield',
          startsOn: '2026-10-22',
          endsOn: '2026-10-25',
          sourceEventIds: [B],
          people: [{ person: chip(A, 'Avery Quill'), reason: 'location_current', detail: 'lives there since Mar', score: 0.7, factId: 'F1' }],
          suggestionId: null,
        },
      ],
      visitors: [{ person: chip(B, 'Blake Ruin'), startsOn: '2026-10-20', endsOn: null, factId: 'F2', suggestionId: null }],
      home: 'Shelbyville',
    });
  });

  it('tickets, met at, Gmail and Google Photos', () => {
    const ticket = {
      id: 'tk-1',
      title: 'Neon Nights',
      performers: ['DJ Sample', 'MC Example'],
      category: 'club' as const,
      genres: ['house'],
      venue: 'The Hall',
      city: 'Springfield',
      startsAt: T,
      endsAt: T + 6 * 3_600_000,
      localDate: '2026-10-14',
      status: 'holding' as const,
      held: 2,
      quantities: { bought: 4, received: 0, sent: 2, sold: 0, refunded: 0 },
      vendors: ['dice'],
      occasionId: C,
      metHere: [chip(A, 'Avery Quill')],
      metHereCount: 1,
    };
    roundTrip(TicketList, { items: [ticket, { ...ticket, id: 'tk-2', status: 'unconfirmed', held: null, occasionId: null, metHere: [], metHereCount: 0 }], nextCursor: `${T}:tk-2` });
    expect(TicketsQuery.parse({})).toEqual({ when: 'upcoming', limit: 30 });
    expect(TicketsQuery.parse({ when: 'past', limit: '5', cursor: `${T}:tk-1` })).toEqual({ when: 'past', limit: 5, cursor: `${T}:tk-1` });
    expect(TicketsQuery.safeParse({ when: 'soon' }).success).toBe(false);
    expect(TicketList.safeParse({ items: [{ ...ticket, status: 'lost' }], nextCursor: null }).success).toBe(false);

    roundTrip(MetAtList, {
      personId: A,
      links: [
        {
          id: B,
          target: { type: 'occasion', id: C },
          title: 'Neon Nights',
          startsAt: T,
          venue: 'The Hall',
          href: `/e/${C}`,
          signal: 'contact_screenshot',
          signalAt: T + 3_600_000,
          confidence: 0.85,
          screenshot: true,
        },
      ],
    });

    const health = { status: 'ok', lastOkAt: T, lastError: null, checkedAt: T };
    roundTrip(GmailStatus, {
      configured: true,
      secretsAvailable: true,
      connected: true,
      connectedAt: T,
      needsReconnect: false,
      lastSyncAt: T,
      health,
      counts: { scanned: 40, ticketEmails: 12, parsed: 10, pending: 2, events: 6, upcoming: 2 },
    });
    roundTrip(GmailDisconnectResult, { connected: false, revoked: false, deleted: { messages: 40, tickets: 6, parties: 3 } });
    roundTrip(GoogleProductDisconnect, { deleteData: true });
    expect(GoogleProductDisconnect.safeParse({ deleteData: 'yes' }).success).toBe(false);
    const session = { id: 'sess-1', status: 'done' as const, itemsTotal: 12, itemsNew: 9, processed: 9, linked: 6, createdAt: T, expiresAt: T + 3_600_000 };
    roundTrip(GphotosSessionView, session);
    roundTrip(GphotosSessionStart, { sessionId: 'sess-1', pickerUri: 'https://photos.google.com/picker/sess-1', expiresAt: null });
    roundTrip(GphotosStatus, {
      configured: true,
      secretsAvailable: true,
      connected: true,
      connectedAt: T,
      needsReconnect: false,
      health: null,
      lastPickAt: T,
      counts: { screenshots: 9, linked: 6, pendingOcr: 0 },
      session,
    });
    roundTrip(GphotosDisconnectResult, { connected: false, revoked: true, filesDeleted: 2, sessionsCancelled: 1, deleted: { screenshots: 9 } });
    expect(GphotosDisconnectResult.safeParse({ connected: true, revoked: true, filesDeleted: 0, sessionsCancelled: 0 }).success).toBe(false);
  });

  it('settings PATCH is strict about keys', () => {
    expect(SettingsPatch.parse({ values: { 'digest.time': '07:30' } })).toEqual({ values: { 'digest.time': '07:30' } });
    expect(SettingsPatch.safeParse({ values: { 'digest.tme': '07:30' } }).success).toBe(false);
    expect(SettingsPatch.safeParse({ values: { 'digest.max_items': 9 } }).success).toBe(false);
    expect(SettingsPatch.parse({ reset: ['digest.time'] })).toEqual({ values: {}, reset: ['digest.time'] });
  });
});
