import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError } from '../api/client';
import { isNotImplemented } from '../api/hooks';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { relativeDay } from '../lib/format';
import { Answer } from './ask/Answer';
import { askKeys, askStore, useConversation, useConversations, useLlmConfigured } from './ask/api';
import { fromStored, type LiveTurn } from './ask/logic';
import { mergeTurns } from './ask/store';
import './ask/ask.css';

const FALLBACK_PROMPTS = ['Who do I know in Austin?', 'Who haven’t I talked to in a while?', 'Who’s into climbing?', 'Who did I meet at parties this year?'];
const MAX_LEN = 2000;

function Composer({ busy, onAsk, onStop, autoFocus }: { busy: boolean; onAsk: (q: string) => void; onStop: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grow with the text up to ~6 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  const send = () => {
    const q = text.trim();
    if (!q || busy) return;
    onAsk(q);
    setText('');
  };
  return (
    <form
      className="ask-composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={ref}
        className="input ask-input"
        rows={1}
        maxLength={MAX_LEN}
        placeholder="Ask about your people…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        aria-label="Question"
        autoFocus={autoFocus}
        enterKeyHint="send"
      />
      {busy ? (
        <button type="button" className="btn" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
          Ask
        </button>
      )}
    </form>
  );
}

function Thread({ turns, onRetry }: { turns: LiveTurn[]; onRetry: (q: string) => void }) {
  return (
    <div className="ask-thread">
      {turns.map((t) => (
        <article key={t.key} className="ask-turn">
          <div className="ask-q">
            <p>{t.question}</p>
          </div>
          <Answer t={t} onRetry={() => onRetry(t.question)} />
        </article>
      ))}
    </div>
  );
}

function History({ currentId, onPick }: { currentId: string | null; onPick?: () => void }) {
  const q = useConversations();
  if (!q.data) return q.isError && !isNotImplemented(q.error) ? <PageState error={q.error} onRetry={() => void q.refetch()} /> : null;
  if (!q.data.conversations.length) return <p className="caption">No earlier questions.</p>;
  return (
    <ul className="ask-history">
      {q.data.conversations.map((c) => (
        <li key={c.id}>
          <Link to={`/ask/${encodeURIComponent(c.id)}`} className={c.id === currentId ? 'active' : undefined} onClick={onPick}>
            <span className="ah-title">{c.title}</span>
            <span className="caption">
              {relativeDay(c.updatedAt)}
              {c.turnCount > 1 ? ` · ${c.turnCount} questions` : ''}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** /ask and /ask/:conversationId — a chat thread over the network, streamed with cited answers. */
export function AskPage() {
  const { conversationId: routeId } = useParams();
  const conversationId = routeId ?? null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const store = askStore();
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const llm = useLlmConfigured();
  const list = useConversations();
  const conv = useConversation(conversationId);
  const bottom = useRef<HTMLDivElement>(null);

  // Settled turns refresh the list and the thread.
  useEffect(() => {
    store.onSettled = (t) => {
      void qc.invalidateQueries({ queryKey: askKeys.list });
      if (t.conversationId) void qc.invalidateQueries({ queryKey: askKeys.conversation(t.conversationId) });
    };
    return () => {
      store.onSettled = null;
    };
  }, [store, qc]);

  // Leaving a thread forgets the draft pointer (the store keeps its turns).
  useEffect(() => {
    if (conversationId) setDraftKey(null);
  }, [conversationId]);

  // A new thread gets its URL as soon as the server names the conversation.
  const draftTurns = draftKey ? store.forDraft(draftKey) : [];
  const namedId = !conversationId ? (draftTurns[0]?.conversationId ?? null) : null;
  useEffect(() => {
    if (namedId) void navigate(`/ask/${encodeURIComponent(namedId)}`, { replace: true });
  }, [namedId, navigate]);

  const stored = useMemo(() => (conv.data && conversationId ? conv.data.turns.map((t) => fromStored(t, conversationId)) : []), [conv.data, conversationId]);
  const live = conversationId ? store.forConversation(conversationId) : draftTurns;
  const turns = conversationId ? mergeTurns(stored, live) : live;
  const busy = store.busy(conversationId, draftKey);
  const lastText = turns[turns.length - 1]?.text.length ?? 0;

  // Follow the answer while it streams, if the reader is near the bottom.
  useEffect(() => {
    const el = bottom.current;
    if (!el || !turns.length) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200;
    if (nearBottom) el.scrollIntoView({ block: 'end' });
  }, [turns.length, lastText]);

  const ask = (q: string) => {
    const key = store.ask(q, conversationId);
    if (!conversationId) setDraftKey(key);
    window.setTimeout(() => bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }), 50);
  };

  const prompts = list.data?.suggestedPrompts.length ? list.data.suggestedPrompts : FALLBACK_PROMPTS;
  const notFound = conversationId && conv.isError && isApiError(conv.error) && (conv.error.status === 404 || conv.error.status === 400);
  const unavailable = list.isError && isNotImplemented(list.error);

  return (
    <div className="ask-page">
      <PageHeader
        title="Ask"
        sub="Questions about your people, answered from your own messages, facts and events"
        actions={
          <span className="head-actions">
            <button type="button" className="btn btn-sm btn-ghost" aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}>
              History
            </button>
            {(conversationId || turns.length > 0) && (
              <Link
                to="/ask"
                className="btn btn-sm"
                onClick={() => {
                  setDraftKey(null);
                  setShowHistory(false);
                }}
              >
                New
              </Link>
            )}
          </span>
        }
      />
      {llm === false && (
        <div className="notice ask-needs-key" role="note">
          <span>
            <strong>Needs AI key.</strong> Until the Anthropic API key is set on the server, Ask answers with a plain local search over your messages, facts
            and events. Nothing is sent anywhere.
          </span>
        </div>
      )}
      {showHistory && (
        <section className="card ask-history-card">
          <h2 className="section-title">Earlier questions</h2>
          <History currentId={conversationId} onPick={() => setShowHistory(false)} />
        </section>
      )}

      {unavailable ? (
        <div className="card-list">
          <Empty title="Ask isn’t available yet." />
        </div>
      ) : notFound ? (
        <div className="card-list">
          <Empty title="That conversation isn’t here anymore.">
            <Link to="/ask">Start a new one</Link>
          </Empty>
        </div>
      ) : conversationId && !conv.data && !live.length ? (
        <PageState error={conv.error} onRetry={() => void conv.refetch()} />
      ) : turns.length === 0 ? (
        <div className="ask-empty">
          <p className="caption">Try one of these:</p>
          <div className="ask-prompts">
            {prompts.slice(0, 6).map((p) => (
              <button key={p} type="button" className="chip plain ask-prompt" onClick={() => ask(p)}>
                <span>{p}</span>
              </button>
            ))}
          </div>
          {!showHistory && list.data && list.data.conversations.length > 0 && (
            <section className="ask-recent">
              <h2 className="section-title">Recent</h2>
              <History currentId={null} />
            </section>
          )}
        </div>
      ) : (
        <Thread turns={turns} onRetry={ask} />
      )}
      <div ref={bottom} className="ask-bottom" />
      {!unavailable && !notFound && <Composer busy={busy} onAsk={ask} onStop={() => store.stopAll(conversationId, draftKey)} autoFocus={!conversationId && typeof window !== 'undefined' && window.matchMedia?.('(min-width: 900px)').matches} />}
    </div>
  );
}
