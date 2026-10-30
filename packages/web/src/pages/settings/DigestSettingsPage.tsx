/**
 * Settings → Digest. The daily text ships OFF: turning it on asks first (it texts the owner's own iMessage). Time,
 * catch-up, item cap, quiet hours, pause, time zone; Preview shows the exact texts, one per suggestion (never sends); "Send test" texts
 * only the owner's own handle and needs "Allow test sends" (the server refuses otherwise).
 */
import { useEffect, useState } from 'react';
import type { DigestSendTest } from '@yb/shared';
import { isApiError } from '../../api/client';
import { isNotImplemented } from '../../api/hooks';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Empty, PageState } from '../../components/PageState';
import { useToast } from '../../components/Toast';
import { date, dateTime, plural } from '../../lib/format';
import { skipReasonLabel } from '../today/logic';
import { useDigestHistory, useDigestPreview, useDigestSendTest } from './api';
import { fieldId, NumberField, SectionTitle, SettingRow, SettingsFrame, TimeField, Toggle, useSettingsForm, type SettingsForm } from './form';
import { hhmmLabel, isTimeZone, pauseUntil } from './logic';

const MARKER = '\u{1F168}';

const STATUS: Record<string, string> = {
  composing: 'Composing',
  ready: 'Ready',
  sent: 'Sent',
  fallback_sent: 'Sent (basic)',
  skipped: 'Skipped',
  failed: 'Failed',
};

const SEND_STATUS: Record<string, string> = {
  delivered: 'Delivered to your own iMessage.',
  sent: 'Sent to your own iMessage.',
  unverified: 'Handed to Messages; delivery not confirmed yet.',
  ghost: 'Messages accepted it but it didn’t show up. Check Sources.',
  failed: 'The send failed. Check Sources.',
  blocked: 'Blocked by a safety check (not your own handle, or the hourly limit).',
};

function Preview() {
  const [on, setOn] = useState(false);
  const q = useDigestPreview(on);
  if (!on)
    return (
      <button type="button" className="btn" onClick={() => setOn(true)}>
        Preview today’s text
      </button>
    );
  if (!q.data) {
    if (isNotImplemented(q.error)) return <p className="caption">Preview isn’t available on this server yet.</p>;
    return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const p = q.data;
  return (
    <div className="st-preview">
      <div className="st-preview-meta caption">
        {p.composer === 'llm' ? 'Written by Claude' : 'Template copy'} · {plural(p.texts.length, 'text')} · {plural(p.items.length, 'item')}
        {' · '}
        {p.wouldSend ? 'would send' : `would not send (${skipReasonLabel(p.reasonNotSent)})`}
      </div>
      {p.texts.map((t, k) => (
        <pre key={k} className="st-bubble" aria-label={`Text ${k + 1} of ${p.texts.length}`}>
          {t}
        </pre>
      ))}
      {p.texts.some((t) => !t.startsWith(MARKER)) && <p className="st-error">A text in this preview doesn’t start with the yeackbot marker; it would not be sent.</p>}
      <div className="caption">Push: “{p.pushBody}”</div>
      <button type="button" className="btn btn-sm btn-ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
        {q.isFetching ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}

function SendTest({ form }: { form: SettingsForm }) {
  const send = useDigestSendTest();
  const toast = useToast();
  const [ask, setAsk] = useState<DigestSendTest['mode'] | null>(null);
  const allowed = form.data.values['delivery.allow_test_send'] || form.data.values['digest.enabled'];
  return (
    <>
      <div className="st-actions">
        <button type="button" className="btn" disabled={!allowed || send.isPending} onClick={() => setAsk('hello')}>
          Send a test line to me
        </button>
        <button type="button" className="btn" disabled={!allowed || send.isPending} onClick={() => setAsk('digest')}>
          Send today’s brief to me
        </button>
      </div>
      {!allowed && <p className="caption">Turn on “Allow test sends” above (and save) to send a test to yourself.</p>}
      <ConfirmDialog
        open={ask != null}
        title="Text yourself a test?"
        confirmLabel="Send to me"
        busy={send.isPending}
        onCancel={() => setAsk(null)}
        onConfirm={() =>
          ask &&
          send.mutate(
            { confirm: true, mode: ask },
            {
              onSuccess: (r) => {
                setAsk(null);
                toast(SEND_STATUS[r.status] ?? 'Sent.', r.status === 'failed' || r.status === 'blocked' || r.status === 'ghost' ? 'error' : 'info');
              },
              onError: (e) => {
                setAsk(null);
                toast(isApiError(e) && e.code === 'SEND_DISABLED' ? 'Test sends are off. Turn on “Allow test sends” first.' : e.message, 'error');
              },
            },
          )
        }
      >
        <p>
          {ask === 'digest' ? 'Today’s brief, exactly as previewed,' : 'One short test line'} goes to <strong>your own iMessage</strong> only. yeackbot
          never texts anyone else.
        </p>
        <p className="caption">One text per suggestion, up to 15 test texts an hour. It isn’t held for quiet hours.</p>
      </ConfirmDialog>
    </>
  );
}

function History() {
  const q = useDigestHistory();
  if (!q.data) {
    if (isNotImplemented(q.error)) return null;
    return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (q.data.digests.length === 0)
    return (
      <div className="card-list">
        <Empty title="No briefs yet." />
      </div>
    );
  return (
    <div className="card-list">
      {q.data.digests.map((d) => {
        const [y, m, day] = d.localDate.split('-').map(Number);
        return (
          <div key={d.id} className="st-hist">
            <span className="st-hist-date">{date(new Date(y!, m! - 1, day!).getTime())}</span>
            <span className="st-hist-meta">
              {STATUS[d.status] ?? d.status} · {plural(d.itemCount, 'item')}
              {d.hadWildcard ? ' · 🎲' : ''}
              {d.sentAt != null ? ` · ${dateTime(d.sentAt)}` : ''}
              {d.pushSentAt != null ? ' · push ✓' : ''}
              {d.emailSentAt != null ? ' · email ✓' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PauseRow({ form }: { form: SettingsForm }) {
  const [day, setDay] = useState('');
  const until = form.data.values['digest.paused_until'];
  const paused = until != null && until > Date.now();
  const at = pauseUntil(day);
  return (
    <SettingRow
      form={form}
      k="digest.paused_until"
      label="Pause"
      description={paused ? `Paused until ${dateTime(until)}. Today still updates.` : 'Skip the daily text for a while (also: reply “pause”).'}
      showDefault={false}
    >
      {paused ? (
        <button type="button" className="btn btn-sm" disabled={form.saving} onClick={() => form.saveNow({ 'digest.paused_until': null }, 'Resumed.')}>
          Resume
        </button>
      ) : (
        <span className="st-inline">
          <input id={fieldId('digest.paused_until')} type="date" className="input input-sm" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Pause through" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={form.saving || at == null}
            onClick={() => at != null && form.saveNow({ 'digest.paused_until': at }, `Paused through ${date(at - 1)}.`)}
          >
            Pause
          </button>
        </span>
      )}
    </SettingRow>
  );
}

function DigestForm({ form }: { form: SettingsForm }) {
  const v = form.values;
  const [confirmOn, setConfirmOn] = useState(false);
  const [tz, setTz] = useState(v.tz);
  // Follow a reset/discard/save from outside the field.
  useEffect(() => setTz((cur) => (cur.trim() === v.tz || !isTimeZone(cur.trim()) ? cur : v.tz)), [v.tz]);
  return (
    <>
      <SectionTitle>Daily text</SectionTitle>
      <div className="card st-card">
        <div className="st-warning" role="note">
          <strong>This texts you.</strong> When it’s on, yeackbot sends a short brief to <em>your own</em> iMessage every morning, starting with
          🅨. It never messages anyone else, and conversation starters are drafts you copy yourself.
        </div>
        <SettingRow form={form} k="digest.enabled" label="Text me the daily brief">
          <Toggle
            id={fieldId('digest.enabled')}
            checked={v['digest.enabled']}
            onChange={(on) => (on ? setConfirmOn(true) : form.set('digest.enabled', false))}
          />
        </SettingRow>
        <SettingRow form={form} k="digest.email">
          <Toggle id={fieldId('digest.email')} checked={v['digest.email']} onChange={(x) => form.set('digest.email', x)} />
        </SettingRow>
        <SettingRow form={form} k="digest.time" formatDefault={(x) => hhmmLabel(String(x))}>
          <TimeField id={fieldId('digest.time')} value={v['digest.time']} onChange={(t) => form.set('digest.time', t)} />
        </SettingRow>
        <SettingRow form={form} k="digest.catch_up_until" formatDefault={(x) => hhmmLabel(String(x))}>
          <TimeField id={fieldId('digest.catch_up_until')} value={v['digest.catch_up_until']} onChange={(t) => form.set('digest.catch_up_until', t)} />
        </SettingRow>
        <SettingRow form={form} k="digest.max_items">
          <NumberField form={form} k="digest.max_items" />
        </SettingRow>
        <SettingRow form={form} k="digest.adaptive_cap">
          <Toggle id={fieldId('digest.adaptive_cap')} checked={v['digest.adaptive_cap']} onChange={(x) => form.set('digest.adaptive_cap', x)} />
        </SettingRow>
        <SettingRow
          form={form}
          k="quiet_hours"
          formatDefault={(x) => {
            const q = x as { start: string; end: string };
            return `${hhmmLabel(q.start)}–${hhmmLabel(q.end)}`;
          }}
        >
          <span className="st-inline">
            <TimeField id={fieldId('quiet_hours')} value={v.quiet_hours.start} onChange={(t) => form.set('quiet_hours', { ...v.quiet_hours, start: t })} />
            <span className="caption">to</span>
            <TimeField value={v.quiet_hours.end} onChange={(t) => form.set('quiet_hours', { ...v.quiet_hours, end: t })} />
          </span>
        </SettingRow>
        <PauseRow form={form} />
        <SettingRow form={form} k="tz" description={`Digest times and day boundaries. This Mac: ${form.data.environment.systemTimeZone}.`}>
          <input
            id={fieldId('tz')}
            className="input input-sm st-tz"
            value={tz}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setTz(e.target.value);
              if (isTimeZone(e.target.value.trim())) form.set('tz', e.target.value.trim());
            }}
            aria-invalid={!isTimeZone(tz.trim())}
          />
        </SettingRow>
      </div>

      <SectionTitle>Preview</SectionTitle>
      <div className="card st-card">
        <p className="caption st-lead">The exact text the morning brief would be today. Previewing never sends anything.</p>
        <Preview />
      </div>

      <SectionTitle>Test</SectionTitle>
      <div className="card st-card">
        <SettingRow form={form} k="delivery.allow_test_send">
          <Toggle id={fieldId('delivery.allow_test_send')} checked={v['delivery.allow_test_send']} onChange={(x) => form.set('delivery.allow_test_send', x)} />
        </SettingRow>
        <SendTest form={form} />
      </div>

      <SectionTitle>Recent briefs</SectionTitle>
      <History />

      <ConfirmDialog
        open={confirmOn}
        title="Text yourself the brief every morning?"
        confirmLabel="Turn on"
        onCancel={() => setConfirmOn(false)}
        onConfirm={() => {
          form.set('digest.enabled', true);
          setConfirmOn(false);
        }}
      >
        <p>
          Each morning at {hhmmLabel(v['digest.time'])} yeackbot sends one iMessage to <strong>your own number</strong>, with up to {v['digest.max_items']}{' '}
          things for the day. Reply “done 2”, “snooze 1 2w”, “pause” and so on from that thread.
        </p>
        <p className="caption">Nothing goes out during quiet hours, and it never texts anyone else. Save to apply.</p>
      </ConfirmDialog>
    </>
  );
}

export function DigestSettingsPage() {
  const { form, query } = useSettingsForm();
  return (
    <SettingsFrame title="Digest" sub="Your morning brief over iMessage" form={form} query={query}>
      {(f) => <DigestForm form={f} />}
    </SettingsFrame>
  );
}
