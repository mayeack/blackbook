/**
 * Settings → Privacy: pseudonymization (always on, shown locked), Claude on/off with budgets and usage, LLM
 * exclusions (people / conversations never sent to the model), Hidden people (THE one place they're listed, with
 * Unhide), do-not-merge pairs (with "allow merging again"), My identities, and Data → JSON export.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useHidden, useUnhide } from '../../api/hooks';
import { EntityRow, IconTile } from '../../components/EntityRow';
import { Empty, PageState } from '../../components/PageState';
import { useToast } from '../../components/Toast';
import { date, percent, plural } from '../../lib/format';
import { identityKindLabel, sourceLabel } from '../../lib/labels';
import { EXPORT_URL, useAllowMerge, useDoNotMerge, useMyIdentities } from './api';
import { fieldId, NumberField, SectionTitle, SettingRow, SettingsFrame, Toggle, useSettingsForm, type SettingsForm } from './form';
import { SettingsIcons } from './icons';
import { addId, budgetShare, normalizeSpend, usd } from './logic';
import { PersonPicker, PickedPerson } from './PersonPicker';

function Meter({ label, spent, budget }: { label: string; spent: number; budget: number }) {
  const share = budgetShare(spent, budget);
  const tone = share == null ? '' : share >= 1 ? 'bad' : share >= 0.8 ? 'warn' : '';
  return (
    <div className="st-meter">
      <div className="st-meter-head">
        <span>{label}</span>
        <span className="st-meter-val">
          {usd(spent)} of {usd(budget)}
        </span>
      </div>
      <div className={`st-meter-track ${tone}`} role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent} aria-label={label}>
        <span style={{ width: `${Math.round((share ?? 0) * 100)}%` }} />
      </div>
    </div>
  );
}

function ClaudeSection({ form }: { form: SettingsForm }) {
  const v = form.values;
  const env = form.data.environment;
  const spend = normalizeSpend(env);
  return (
    <div className="card st-card">
      {!env.llmConfigured && (
        <div className="st-note" role="note">
          No Claude API key on the server yet, so nothing is sent anywhere: extraction is skipped and the brief uses templates.
        </div>
      )}
      <SettingRow form={form} k="llm.enabled">
        <Toggle id={fieldId('llm.enabled')} checked={v['llm.enabled']} onChange={(x) => form.set('llm.enabled', x)} />
      </SettingRow>
      {spend ? (
        <div className="st-meters">
          <Meter label="Today" spent={spend.todayUsd} budget={form.data.values['llm.daily_budget_usd']} />
          <Meter label="This month" spent={spend.monthUsd} budget={form.data.values['llm.monthly_budget_usd']} />
          <Meter label="Backfill" spent={spend.backfillUsd} budget={form.data.values['llm.backfill_budget_usd']} />
          <p className="caption">
            {spend.requestsToday != null ? `${plural(spend.requestsToday, 'request')} today` : ''}
            {spend.cacheHitRate != null ? `${spend.requestsToday != null ? ' · ' : ''}${percent(spend.cacheHitRate)} prompt-cache hits (7 days)` : ''}
          </p>
        </div>
      ) : (
        <p className="caption st-lead">Spend isn’t reported by this server yet. When a cap is reached, Claude steps are skipped until the next day or month.</p>
      )}
      <SettingRow form={form} k="llm.daily_budget_usd" formatDefault={(x) => usd(Number(x))}>
        <NumberField form={form} k="llm.daily_budget_usd" step={0.5} suffix="USD" />
      </SettingRow>
      <SettingRow form={form} k="llm.monthly_budget_usd" formatDefault={(x) => usd(Number(x))}>
        <NumberField form={form} k="llm.monthly_budget_usd" step={5} suffix="USD" />
      </SettingRow>
      <SettingRow form={form} k="llm.backfill_budget_usd" formatDefault={(x) => usd(Number(x))}>
        <NumberField form={form} k="llm.backfill_budget_usd" step={10} suffix="USD" />
      </SettingRow>
    </div>
  );
}

/** The Ollama model on this Mac that reads "yb …" texts before Claude does. */
function LocalModelSection({ form }: { form: SettingsForm }) {
  const v = form.values;
  const model = v['llm.local_model'];
  const [text, setText] = useState(model);
  useEffect(() => setText((t) => (t.trim() === model ? t : model)), [model]);
  return (
    <div className="card st-card">
      <SettingRow form={form} k="llm.local_enabled">
        <Toggle id={fieldId('llm.local_enabled')} checked={v['llm.local_enabled']} onChange={(x) => form.set('llm.local_enabled', x)} />
      </SettingRow>
      <SettingRow form={form} k="llm.local_model">
        <input
          id={fieldId('llm.local_model')}
          className="input input-sm st-text-input"
          value={text}
          maxLength={100}
          placeholder="llama3.1:8b"
          disabled={!v['llm.local_enabled']}
          onChange={(e) => {
            setText(e.target.value);
            const t = e.target.value.trim();
            if (t) form.set('llm.local_model', t);
          }}
        />
      </SettingRow>
      <p className="caption st-lead">Runs in Ollama on this Mac, free. When it isn’t running or the model isn’t pulled, Claude reads your texts as before.</p>
    </div>
  );
}

function Exclusions({ form }: { form: SettingsForm }) {
  const people = form.values['llm.excluded_person_ids'];
  const convs = form.values['llm.excluded_conversation_ids'];
  const [convId, setConvId] = useState('');
  const full = people.length >= 500;
  return (
    <div className="card st-card">
      <p className="caption st-lead">Messages with these people or in these conversations are never sent to Claude, even pseudonymized.</p>
      <h3 className="sub-title">People</h3>
      {people.length > 0 && (
        <div className="card-list st-sublist">
          {people.map((id) => (
            <PickedPerson
              key={id}
              id={id}
              onRemove={() =>
                form.set(
                  'llm.excluded_person_ids',
                  people.filter((x) => x !== id),
                )
              }
            />
          ))}
        </div>
      )}
      <PersonPicker exclude={people} busy={full} onPick={(id) => form.set('llm.excluded_person_ids', addId(people, id))} placeholder="Exclude someone…" />

      <h3 className="sub-title">Conversations</h3>
      {convs.length === 0 ? (
        <p className="caption">None excluded.</p>
      ) : (
        <div className="card-list st-sublist">
          {convs.map((id) => (
            <EntityRow
              key={id}
              icon={<IconTile>{SettingsIcons.digest}</IconTile>}
              title={<span className="mono">{id}</span>}
              subtitle="Conversation"
              trailing={
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => form.set('llm.excluded_conversation_ids', convs.filter((x) => x !== id))}>
                  Remove
                </button>
              }
            />
          ))}
        </div>
      )}
      <div className="st-inline st-add-id">
        <input
          className="input input-sm st-text-input"
          value={convId}
          maxLength={64}
          placeholder="Conversation id"
          aria-label="Conversation id to exclude"
          onChange={(e) => setConvId(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!convId.trim() || convs.length >= 500}
          onClick={() => {
            form.set('llm.excluded_conversation_ids', addId(convs, convId));
            setConvId('');
          }}
        >
          Exclude
        </button>
      </div>
    </div>
  );
}

/** Settings → Hidden: rows are deliberately not links (a hidden person has no page) and use an icon tile. */
function HiddenPeople() {
  const hidden = useHidden();
  const unhide = useUnhide();
  const toast = useToast();
  return (
    <div className="card-list">
      {hidden.isError ? (
        <PageState error={hidden.error} onRetry={() => void hidden.refetch()} />
      ) : !hidden.data ? (
        <Empty title="Loading…" />
      ) : hidden.data.items.length === 0 ? (
        <Empty title="No hidden people.">People you hide stay out of every list, search, suggestion and the graph, and appear only here.</Empty>
      ) : (
        hidden.data.items.map((p) => (
          <EntityRow
            key={p.id}
            icon={<IconTile>{SettingsIcons.hidden}</IconTile>}
            title={p.displayName}
            subtitle={p.company}
            trailing={
              <button
                type="button"
                className="btn btn-sm"
                disabled={unhide.isPending}
                onClick={() =>
                  unhide.mutate(p.id, {
                    onSuccess: () => toast('Unhidden. You can undo this from Today.'),
                    onError: (e) => toast(e.message, 'error'),
                  })
                }
              >
                Unhide
              </button>
            }
          />
        ))
      )}
    </div>
  );
}

const DNM_SOURCE: Record<string, string> = { undo: 'Split or undone merge', user: 'You said not the same', llm_different: 'Claude said different' };

/** Do-not-merge pairs: the matcher never proposes them again; "Allow" removes the block (undo from Today). */
function DoNotMergePairs() {
  const q = useDoNotMerge();
  const allow = useAllowMerge();
  const toast = useToast();
  return (
    <div className="card-list">
      {q.isError ? (
        <PageState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Empty title="Loading…" />
      ) : q.data.pairs.length === 0 ? (
        <Empty title="No do-not-merge pairs.">Splitting a merge (or undoing one from Today) records the pair here so the agent never merges those two again.</Empty>
      ) : (
        q.data.pairs.map((p) => (
          <EntityRow
            key={`${p.a.id}-${p.b.id}`}
            icon={<IconTile>≠</IconTile>}
            title={`${p.a.displayName} ≠ ${p.b.displayName}`}
            subtitle={`${DNM_SOURCE[p.source] ?? p.source} · ${date(p.createdAt)}`}
            trailing={
              <button
                type="button"
                className="btn btn-sm"
                disabled={allow.isPending}
                onClick={() =>
                  allow.mutate(
                    { a: p.a.id, b: p.b.id },
                    { onSuccess: () => toast('They can be merged again. Undo from Today.'), onError: (e) => toast(e.message, 'error') },
                  )
                }
              >
                Allow
              </button>
            }
          />
        ))
      )}
    </div>
  );
}

/** The owner's own accounts (masked): what the agent recognizes as "you". */
function MyIdentitiesList() {
  const q = useMyIdentities();
  return (
    <div className="card-list">
      {q.isError ? (
        <PageState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Empty title="Loading…" />
      ) : q.data.identities.length === 0 ? (
        <Empty title="No accounts linked to you yet.">They appear once your messages and Contacts card are read.</Empty>
      ) : (
        q.data.identities.map((i) => (
          <EntityRow key={i.id} icon={<IconTile>{SettingsIcons.privacy}</IconTile>} title={i.value} subtitle={`${identityKindLabel(i.kind)} · from ${sourceLabel(i.source)}`} />
        ))
      )}
      {q.data && (
        <p className="caption st-foot">
          {q.data.selfHandleCount > 0
            ? `${plural(q.data.selfHandleCount, 'handle')} set up for texting yourself (npm run setup:self).`
            : 'Texting yourself isn’t set up yet (npm run setup:self).'}
        </p>
      )}
    </div>
  );
}

function PrivacyForm({ form }: { form: SettingsForm }) {
  return (
    <>
      <SectionTitle>Pseudonymization</SectionTitle>
      <div className="card st-card">
        <div className="st-row">
          <div className="st-text">
            <span className="st-label">
              Pseudonymize everything sent to Claude <span className="pill st-inline-pill">Always on</span>
            </span>
            <div className="st-desc">
              Names, phone numbers, emails and handles are replaced with tokens like P1 before anything leaves this Mac, and swapped back locally. It
              can’t be turned off.
            </div>
          </div>
          <div className="st-control">
            <span className="st-lock" aria-label="Locked on">
              {SettingsIcons.privacy}
            </span>
            <Toggle checked disabled label="Pseudonymization (always on)" onChange={() => undefined} />
          </div>
        </div>
      </div>

      <SectionTitle>On this Mac</SectionTitle>
      <LocalModelSection form={form} />

      <SectionTitle>Claude</SectionTitle>
      <ClaudeSection form={form} />

      <SectionTitle>Never sent to Claude</SectionTitle>
      <Exclusions form={form} />

      <h2 className="section-title" id="hidden">
        Hidden people
      </h2>
      <HiddenPeople />

      <SectionTitle>Do-not-merge pairs</SectionTitle>
      <p className="caption st-foot">
        Each person’s page lists the records merged into them under Merge history, with Split. <Link to="/today">Recent merges are on Today</Link>.
      </p>
      <DoNotMergePairs />

      <SectionTitle>My identities</SectionTitle>
      <MyIdentitiesList />

      <SectionTitle>Data</SectionTitle>
      <div className="card st-card">
        <div className="st-row">
          <div className="st-text">
            <span className="st-label">Export everything as JSON</span>
            <div className="st-desc">People with their accounts, facts, notes and open promises, plus circles, tags and places. Saved by your browser; nothing is sent anywhere.</div>
          </div>
          <div className="st-control">
            <a className="btn btn-sm" href={EXPORT_URL} download>
              Download
            </a>
          </div>
        </div>
      </div>
      <p className="caption st-foot">
        Your data stays on this Mac. Only pseudonymized message windows go to Claude, and only when it’s on. <Link to="/sources">Sources</Link> shows what’s
        read from where.
      </p>
    </>
  );
}

export function PrivacySettingsPage() {
  const { form, query } = useSettingsForm();
  return (
    <SettingsFrame title="Privacy" sub="What leaves this Mac, and who is hidden" form={form} query={query}>
      {(f) => <PrivacyForm form={f} />}
    </SettingsFrame>
  );
}
