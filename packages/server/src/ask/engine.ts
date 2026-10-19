/**
 * THE Ask engine, shared by the web (POST /ask, SSE) and the iMessage `?` command (intelligence §7):
 *
 *   1. record a running turn (ask_turns), refresh the people / events indexes;
 *   2. no LLM available (no key, Claude off, budget, egress refused) → a retrieval-only answer (`degraded`);
 *   3. otherwise one tool-use loop through LlmClient.runTools on the channel's route (ask_web / ask_imessage in
 *      llm/models.ts: Haiku 5.5, effort low, adaptive thinking; tools + system cached 5 min, the moving breakpoint on
 *      the last user message): tool_choice auto with the six strict read-only tools, ≤ 8 tool calls, ≤ 60k input tokens,
 *      append-only history (the client echoes response.content). The user turn and EVERY tool result go through
 *      egress.pseudonymize; tool results are wrapped as untrusted data;
 *   4. citation ids no tool returned in the conversation are stripped (and counted), person tokens become
 *      names, citations resolve to labels + deep links; an answer listing people becomes one line per person plus
 *      structured rows (people-list.ts; the web's table); the turn is stored for the conversation history.
 *
 * Ask writes nothing journaled: the tools are read-only and the only rows written are Ask's own history and
 * index tables. Logs carry ids and counts only (never the question, tool inputs or answer text).
 */
import type { AskCitation, AskEvent, AskPeopleList, AskUsage, PersonChip } from '@yb/shared';
import type { DB } from '../db/connection';
import { ASK_MAX_TOOL_CALLS, EgressBlocked, type LlmToolLoopOutcome, type LlmUnavailableReason } from '../llm/types';
import { errorFields, type Logger } from '../ops/logger';
import { maskText } from '../routes/people';
import { servicesFor, type AgentServices, type ServicesConfig, type ServicesProvider } from '../services';
import { personChips, resolveCitation, resolveCitations, type CitationContext } from './citations';
import { degradedAnswer, intentOf, type DegradedReason } from './degraded';
import { ensureAskIndexes } from './fts';
import { ASK_PROMPT_VERSION, ASK_ROUTE, ASK_SYSTEM_PROMPT, askEstimateUsd, userTurnSections, type AskChannel } from './prompt';
import { asksForPeople, buildPeopleList, peopleLinesOf } from './people-list';
import { detokenize, personTokensIn, processAnswer, tidy } from './refs';
import { answerNames, createScope, firstNameOf, mentionedPeople, shortName, summarize, type AskScope, type PersonRow, type PersonSummary } from './retrieval';
import { closeStaleTurns, finishTurn, priorContext, startTurn, type TurnResult } from './store';
import { DeltaFilter } from './stream';
import { ASK_TOOL_DEFS, AskSession, executeTool, isAskTool, runningSummary } from './tools';

export interface AskEngineRequest {
  db: DB;
  question: string;
  channel: 'web' | 'imessage';
  /** Continue a conversation (web). */
  conversationId?: string | null;
  /** Streams start/tool_status/delta/citation events (web SSE); `done`/`error` are the return value. */
  onEvent?: (event: AskEvent) => void;
  services?: ServicesProvider;
  /** Used to build the default services when `services` isn't given. */
  config?: ServicesConfig;
  log?: Logger;
  signal?: AbortSignal;
  now?: number;
}

export interface AskEngineAnswer {
  conversationId: string | null;
  turnId: string | null;
  /** Web: full answer with valid citation ids. iMessage callers format it (≤600 chars, footnotes, no sensitive facts). */
  answer: string;
  citations: AskCitation[];
  people: PersonChip[];
  /** Set when the answer lists people: one row per person (the web renders a table; iMessage drops footnotes). */
  list: AskPeopleList | null;
  degraded: boolean;
  /** Why no LLM answered (degraded only): 'no_key', 'budget_daily', … */
  degradedReason?: DegradedReason | null;
  usage?: AskUsage | null;
  /** Set when the turn failed (aborted, internal error): the web sends an `error` event instead of `done`. */
  error?: { code: string; message: string } | null;
}

/** Hard ceiling on one turn (the web's p95 target is 20 s; iMessage 30 s). */
export const ASK_TIMEOUT_MS = 120_000;

const REFUSED_ANSWER = 'I can’t help with that one.';

export async function askNetwork(req: AskEngineRequest): Promise<AskEngineAnswer> {
  const { db, channel } = req;
  const now = req.now ?? Date.now();
  const question = req.question.replace(/\s+/g, ' ').trim().slice(0, 2000);
  const started = performance.now();
  if (!question) return { conversationId: null, turnId: null, answer: 'Ask me something about your network.', citations: [], people: [], list: null, degraded: true, degradedReason: null, usage: null };

  closeStaleTurns(db, now);
  const turn = startTurn(db, { conversationId: req.conversationId, question, channel, now });
  req.onEvent?.({ type: 'start', conversationId: turn.conversationId, turnId: turn.turnId });
  const base = { conversationId: turn.conversationId, turnId: turn.turnId };
  const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(ASK_TIMEOUT_MS)]) : AbortSignal.timeout(ASK_TIMEOUT_MS);

  try {
    await ensureAskIndexes(db, now);
    const services = req.services ? req.services(db) : servicesFor(db, req.config, req.log);
    const out = await answerTurn({ req, services, question, turn, now, signal });
    finishTurn(db, turn.turnId, out.result, Date.now());
    req.log?.info('ask.turn', {
      ids: [turn.turnId],
      counts: {
        tool_calls: out.result.toolCalls,
        citations: out.result.citations.length,
        stripped: out.result.violations,
        people: out.result.people.length,
        degraded: out.result.status === 'degraded' ? 1 : 0,
        web: channel === 'web' ? 1 : 0,
      },
      duration_ms: performance.now() - started,
    });
    if (out.result.violations > 0) req.log?.warn('ask.citation_violation', { ids: [turn.turnId], counts: { stripped: out.result.violations } });
    if (out.result.status === 'error') {
      return { ...base, answer: out.result.answer ?? '', citations: [], people: [], list: null, degraded: false, usage: out.result.usage, error: { code: out.result.errorCode ?? 'error', message: out.result.answer ?? 'Ask failed.' } };
    }
    return {
      ...base,
      answer: out.result.answer ?? '',
      citations: out.result.citations,
      people: out.result.people,
      list: out.result.list ?? null,
      degraded: out.result.status === 'degraded',
      degradedReason: (out.result.degradedReason as DegradedReason | null) ?? null,
      usage: out.result.usage,
      error: null,
    };
  } catch (e) {
    req.log?.error('ask.failed', { ids: [turn.turnId], ...errorFields(e) });
    const message = 'Ask hit a problem. Try again in a moment.';
    finishTurn(db, turn.turnId, emptyResult('error', message, 'internal'), Date.now());
    return { ...base, answer: message, citations: [], people: [], list: null, degraded: false, usage: null, error: { code: 'internal', message } };
  }
}

function emptyResult(status: TurnResult['status'], answer: string, errorCode: string | null = null): TurnResult {
  return { status, answer, modelAnswer: null, citations: [], people: [], list: null, citableIds: [], errorCode, toolCalls: 0, violations: 0, usage: null };
}

interface TurnInput {
  req: AskEngineRequest;
  services: AgentServices;
  question: string;
  turn: { conversationId: string; turnId: string; seq: number };
  now: number;
  signal: AbortSignal;
}

const displayNameFor = (channel: AskChannel) => (p: PersonRow) => (channel === 'web' ? maskText(p.display_name) : shortName(p));

function citationContext(scope: AskScope, channel: AskChannel, personOfToken: (t: string) => PersonRow | null): CitationContext {
  return { scope, personOfToken, displayName: displayNameFor(channel) };
}

/** The retrieval-only answer (nothing leaves the Mac). */
function degrade(t: TurnInput, reason: DegradedReason, found: PersonSummary[] = []): { result: TurnResult } {
  const { req, question, now } = t;
  const scope = createScope(req.db, { now, forModel: false });
  const o = { channel: req.channel, displayName: displayNameFor(req.channel), found };
  let d = degradedAnswer(scope, question, reason, o);
  if (req.channel !== 'web') {
    // Its people are named together, like a model answer's (answerNames); a second pass only when a short name collides.
    const named = answerNames(req.db, d.people);
    if (named.colliding.size) d = degradedAnswer(scope, question, reason, { ...o, displayName: named.of });
  }
  const citations = resolveCitations(citationContext(scope, req.channel, () => null), d.cited);
  return {
    result: {
      status: 'degraded',
      answer: d.answer,
      // Degraded text carries real names: never replayed to the model.
      modelAnswer: null,
      citations,
      people: personChips(scope, d.people),
      list: d.list,
      citableIds: [],
      degradedReason: reason,
      toolCalls: 0,
      violations: 0,
      usage: null,
    },
  };
}

const usageOf = (o: Exclude<LlmToolLoopOutcome, { status: 'unavailable' }>, toolCalls: number): AskUsage => ({
  toolCalls,
  inputTokens: o.usage.inputTokens + o.usage.cacheReadInputTokens + o.usage.cacheCreationInputTokens,
  outputTokens: o.usage.outputTokens,
  costUsd: Math.round(o.usage.costUsd * 1e6) / 1e6,
});

async function answerTurn(t: TurnInput): Promise<{ result: TurnResult }> {
  const { req, services, question, turn, now, signal } = t;
  const { db, channel } = req;
  const estimateUsd = askEstimateUsd(services.llm.params(ASK_ROUTE[channel]));
  const spend = services.llm.canSpend('steady', estimateUsd);
  if (!spend.ok) return degrade(t, spend.reason);

  const scope = createScope(db, { now, forModel: true });
  const session = new AskSession(scope, services.egress);
  const prior = priorContext(db, turn.conversationId, turn.seq);
  for (const id of prior.citable) session.citable.add(id);

  // The user turn: context, earlier turns (tokenized), people the question seems to name, the question.
  let userText: string;
  try {
    const named = summarize(
      scope,
      mentionedPeople(scope, question).map((p) => p.id),
    );
    const mentioned = named.map((s) => ({ token: session.token(s.person), name: shortName(s.person), strength: s.strength, city: s.city }));
    // People named in earlier questions too, so their last names are cut to an initial when the thread is replayed.
    const people = new Map<string, PersonRow>(named.map((s) => [s.person.id, s.person]));
    for (const p of prior.turns.flatMap((pt) => mentionedPeople(scope, pt.question))) people.set(p.id, p);
    const packet = services.egress.pseudonymize({
      purpose: 'ask',
      sections: userTurnSections({ question, channel, now, tz: scope.tz, prior: prior.turns, mentioned }),
      people: [...people.values()].map((p) => ({ personId: p.id, firstName: p.first_name, lastName: p.last_name })),
    });
    session.learn(packet.tokenMap);
    userText = packet.text;
  } catch (e) {
    if (e instanceof EgressBlocked) return degrade(t, 'egress_blocked');
    throw e;
  }

  const personOfToken = (tok: string) => session.tokenPerson.get(tok) ?? session.resolve(tok);
  const display = displayNameFor(channel);
  const personName = (tok: string) => {
    const p = personOfToken(tok);
    return p ? display(p) : null;
  };
  const cctx = citationContext(scope, channel, personOfToken);
  const announced = new Set<string>();
  const filter = new DeltaFilter({
    citable: () => session.citable,
    personName,
    me: 'you',
    emit: (text) => req.onEvent?.({ type: 'delta', text }),
    onCitation: (id) => {
      const c = resolveCitation(cctx, id);
      if (c && req.onEvent) {
        announced.add(id);
        req.onEvent({ type: 'citation', citation: c });
      }
    },
  });

  const outcome = await services.llm.runTools({
    kind: 'ask',
    route: ASK_ROUTE[channel],
    subjectRef: turn.turnId,
    promptVersion: ASK_PROMPT_VERSION[channel],
    system: ASK_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
    pool: 'steady',
    estimateUsd,
    runId: null,
    tools: [...ASK_TOOL_DEFS],
    maxToolCalls: ASK_MAX_TOOL_CALLS,
    executeTool: (call) => executeTool(session, call),
    onTextDelta: req.onEvent ? (d) => filter.push(d) : undefined,
    onToolStatus: (call, status) => {
      if (!req.onEvent || !isAskTool(call.name)) return;
      const done = session.outcomes.get(call.id);
      req.onEvent({
        type: 'tool_status',
        tool: call.name,
        status,
        summary: status === 'running' ? runningSummary(session, call) : (done?.summary ?? null),
        count: status === 'running' ? null : (done?.count ?? null),
      });
    },
    signal,
  });
  filter.end();

  if (outcome.status === 'unavailable') {
    if (outcome.reason === 'aborted' || signal.aborted) {
      return { result: { ...emptyResult('error', 'The question was cancelled.', 'aborted'), toolCalls: session.toolCalls } };
    }
    return degrade(t, outcome.reason as LlmUnavailableReason, session.surfaced);
  }
  const usage = usageOf(outcome, session.toolCalls);
  if (outcome.status === 'refused') {
    return { result: { ...emptyResult('done', REFUSED_ANSWER), toolCalls: session.toolCalls, usage, llmRequest: outcome.requestId, promptVersion: ASK_PROMPT_VERSION[channel] } };
  }

  let raw = outcome.text ?? '';
  if (outcome.status === 'max_tokens' || outcome.status === 'tool_limit') {
    if (!raw.trim()) {
      const d = degrade(t, 'tool_limit', session.surfaced);
      return { result: { ...d.result, toolCalls: session.toolCalls, usage } };
    }
    if (outcome.status === 'max_tokens') raw = `${raw.trim()}… (cut short)`;
  }
  for (const id of outcome.citableIds) session.citable.add(id);

  // Over iMessage the people one answer names are named together (answerNames): "Sam R.", or "Sam Rivera" where that
  // reads as the owner's own short name or another person's in the answer. Local only: the model saw "Sam R." and tokens.
  const answerDisplay =
    channel === 'web'
      ? display
      : answerNames(
          db,
          personTokensIn(raw, (tok) => !!personOfToken(tok))
            .map(personOfToken)
            .filter((p): p is PersonRow => !!p),
        ).of;
  const answerName = (tok: string) => {
    const p = personOfToken(tok);
    return p ? answerDisplay(p) : null;
  };
  const processed = processAnswer(raw, {
    citable: session.citable,
    personName: answerName,
    personFirst: (tok) => {
      const p = personOfToken(tok);
      return p ? firstNameOf(p) : null;
    },
    me: 'you',
  });
  const citations = resolveCitations({ ...cctx, displayName: answerDisplay }, processed.cited);
  for (const c of citations) if (!announced.has(c.ref)) req.onEvent?.({ type: 'citation', citation: c });
  const mentionedPeopleRows = processed.personTokens.map(personOfToken).filter((p): p is PersonRow => !!p);
  // A list of people: one line per person with their details (and rows for the web's table).
  const listed = peopleLinesOf(processed.modelText, {
    person: personOfToken,
    display: (s) => tidy(detokenize(s, answerName, 'you')),
    peopleQuestion: asksForPeople(question) || intentOf(question) !== null,
  });
  const people = listed ? buildPeopleList(scope, listed, answerDisplay) : null;
  return {
    result: {
      status: 'done',
      answer: people?.text || processed.text || 'I couldn’t find anything on that.',
      modelAnswer: processed.modelText,
      citations,
      people: personChips(scope, mentionedPeopleRows),
      list: people?.list ?? null,
      citableIds: [...session.citable],
      toolCalls: session.toolCalls,
      violations: processed.violations,
      usage,
      llmRequest: outcome.requestId,
      promptVersion: ASK_PROMPT_VERSION[channel],
    },
  };
}
