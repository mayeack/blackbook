/**
 * Settings → Agent: fading/dormant thresholds and the ignore cooldown (intelligence §3: only the owner moves these,
 * learning never does), the ranker (learning on/off, 🎲 wildcard chance), and features (text commands, intros,
 * home city for travel intel).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fieldId, NumberField, SectionTitle, SettingRow, SettingsFrame, Toggle, useSettingsForm, type SettingsForm } from './form';
import { parseSenderDomains, pct } from './logic';

function WildcardRow({ form }: { form: SettingsForm }) {
  const v = form.values['learner.wildcard_epsilon'];
  return (
    <SettingRow form={form} k="learner.wildcard_epsilon" formatDefault={(x) => pct(Number(x))}>
      <span className="st-inline">
        <input
          id={fieldId('learner.wildcard_epsilon')}
          type="range"
          min={0}
          max={0.5}
          step={0.05}
          value={v}
          onChange={(e) => form.set('learner.wildcard_epsilon', Math.round(Number(e.target.value) * 100) / 100)}
        />
        <span className="st-range-val">{pct(v)}</span>
      </span>
    </SettingRow>
  );
}

function HomeCityRow({ form }: { form: SettingsForm }) {
  const v = form.values['travel.home_city'];
  const [text, setText] = useState(v ?? '');
  useEffect(() => setText((t) => (t.trim() === (v ?? '') ? t : (v ?? ''))), [v]);
  return (
    <SettingRow form={form} k="travel.home_city" formatDefault={(x) => (x == null ? 'your location fact' : String(x))}>
      <input
        id={fieldId('travel.home_city')}
        className="input input-sm st-text-input"
        value={text}
        maxLength={80}
        placeholder="e.g. Springfield"
        onChange={(e) => {
          setText(e.target.value);
          const t = e.target.value.trim();
          form.set('travel.home_city', t ? t : null);
        }}
      />
    </SettingRow>
  );
}

/** gmail.extra_senders: e.g. a members' club or a promoter whose event mail should count as tickets. */
function ExtraSendersRow({ form }: { form: SettingsForm }) {
  const v = form.values['gmail.extra_senders'];
  const joined = v.join(', ');
  const [text, setText] = useState(joined);
  useEffect(() => setText((t) => (parseSenderDomains(t).join(', ') === joined ? t : joined)), [joined]);
  return (
    <SettingRow form={form} k="gmail.extra_senders" formatDefault={() => 'none'}>
      <input
        id={fieldId('gmail.extra_senders')}
        className="input input-sm st-text-input"
        value={text}
        maxLength={1000}
        placeholder="e.g. club.example, tickets.venue.example"
        onChange={(e) => {
          setText(e.target.value);
          form.set('gmail.extra_senders', parseSenderDomains(e.target.value));
        }}
      />
    </SettingRow>
  );
}

function AgentForm({ form }: { form: SettingsForm }) {
  const v = form.values;
  return (
    <>
      <SectionTitle>Fading</SectionTitle>
      <div className="card st-card">
        <p className="caption st-lead">
          Someone is <strong>fading</strong> when the silence is several times their usual gap, after enough quiet days, for a relationship that used to be
          real. Learning never changes these; only you do.
        </p>
        <SettingRow form={form} k="agent.fading_multiple" formatDefault={(x) => `${x}×`}>
          <NumberField form={form} k="agent.fading_multiple" step={0.25} suffix="×" />
        </SettingRow>
        <SettingRow form={form} k="agent.fading_min_silence_days">
          <NumberField form={form} k="agent.fading_min_silence_days" suffix="days" />
        </SettingRow>
        <SettingRow form={form} k="agent.fading_min_historical">
          <NumberField form={form} k="agent.fading_min_historical" step={5} />
        </SettingRow>
        <SettingRow form={form} k="agent.fading_min_contact_days">
          <NumberField form={form} k="agent.fading_min_contact_days" suffix="days" />
        </SettingRow>
      </div>

      <SectionTitle>Priority people</SectionTitle>
      <div className="card st-card">
        <SettingRow form={form} k="agent.priority_fading_multiple" formatDefault={(x) => `${x}×`}>
          <NumberField form={form} k="agent.priority_fading_multiple" step={0.25} suffix="×" />
        </SettingRow>
        <SettingRow form={form} k="agent.priority_min_silence_days">
          <NumberField form={form} k="agent.priority_min_silence_days" suffix="days" />
        </SettingRow>
        <SettingRow form={form} k="agent.priority_min_historical">
          <NumberField form={form} k="agent.priority_min_historical" step={5} />
        </SettingRow>
      </div>

      <SectionTitle>Dormant and cooldowns</SectionTitle>
      <div className="card st-card">
        <SettingRow form={form} k="agent.dormant_days">
          <NumberField form={form} k="agent.dormant_days" step={15} suffix="days" />
        </SettingRow>
        <SettingRow form={form} k="agent.ignore_cooldown_days">
          <NumberField form={form} k="agent.ignore_cooldown_days" suffix="days" />
        </SettingRow>
      </div>

      <SectionTitle>Suggestions</SectionTitle>
      <div className="card st-card">
        <SettingRow form={form} k="learner.enabled">
          <Toggle id={fieldId('learner.enabled')} checked={v['learner.enabled']} onChange={(x) => form.set('learner.enabled', x)} />
        </SettingRow>
        <WildcardRow form={form} />
        <SettingRow form={form} k="intros.enabled">
          <Toggle id={fieldId('intros.enabled')} checked={v['intros.enabled']} onChange={(x) => form.set('intros.enabled', x)} />
        </SettingRow>
        <p className="caption st-lead">
          See what the ranker has learned, and unmute kinds or people, in <Link to="/settings/learned">What I’ve learned</Link>.
        </p>
      </div>

      <SectionTitle>Features</SectionTitle>
      <div className="card st-card">
        <SettingRow form={form} k="commands.enabled">
          <Toggle id={fieldId('commands.enabled')} checked={v['commands.enabled']} onChange={(x) => form.set('commands.enabled', x)} />
        </SettingRow>
        <SettingRow form={form} k="commands.read_images">
          <Toggle id={fieldId('commands.read_images')} checked={v['commands.read_images']} onChange={(x) => form.set('commands.read_images', x)} />
        </SettingRow>
        <HomeCityRow form={form} />
        <ExtraSendersRow form={form} />
      </div>
    </>
  );
}

export function AgentSettingsPage() {
  const { form, query } = useSettingsForm();
  return (
    <SettingsFrame title="Agent" sub="Thresholds, wildcards and features" form={form} query={query}>
      {(f) => <AgentForm form={f} />}
    </SettingsFrame>
  );
}
