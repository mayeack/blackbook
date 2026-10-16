/**
 * Settings root: account, the agent-loop sub-screens (Digest, Push, Agent, Privacy, What I've learned), Calendars
 * (the Google card: the OAuth callback lands here with ?google=…), and Eval.
 */
import { useMe } from '../../api/hooks';
import { EntityRow, IconTile } from '../../components/EntityRow';
import { GoogleCalendarPanel } from '../../components/GoogleCalendar';
import { Icons } from '../../components/icons';
import { PageHeader } from '../../components/PageState';
import { pct, usd, hhmmLabel } from './logic';
import { useSettings } from './api';
import { SettingsIcons } from './icons';
import './settings.css';

const chevron = <span className="chevron">{Icons.chevron}</span>;

export function SettingsPage() {
  const me = useMe();
  const s = useSettings();
  const v = s.data?.values;
  const env = s.data?.environment;
  const off = s.isError ? 'Not available yet' : undefined;

  const digestSub = v
    ? v['digest.enabled']
      ? `Texts you at ${hhmmLabel(v['digest.time'])} · up to ${v['digest.max_items']} items`
      : 'Daily text off · brief shows on Today'
    : off;
  const pushSub = v ? (v['push.enabled'] ? 'On' : 'Off') + (env && !env.pushConfigured ? ' · not set up on the server' : '') : off;
  const agentSub = v
    ? `Fading at ${v['agent.fading_multiple']}× usual gap · 🎲 ${pct(v['learner.wildcard_epsilon'])} · intros ${v['intros.enabled'] ? 'on' : 'off'}`
    : off;
  const privacySub = v
    ? `Pseudonymized · Claude ${!env?.llmConfigured ? 'not set up' : v['llm.enabled'] ? 'on' : 'off'} · ${usd(v['llm.daily_budget_usd'])}/day`
    : off;

  return (
    <>
      <PageHeader title="Settings" />
      <h2 className="section-title">Account</h2>
      <div className="card-list">
        <EntityRow
          icon={<IconTile accent>{Icons.settings}</IconTile>}
          title={me.data ? me.data.email : me.isError ? 'Not signed in' : 'Loading…'}
          subtitle={me.data ? (me.data.via === 'access' ? 'Signed in through Cloudflare Access' : 'Development sign-in') : undefined}
        />
      </div>

      <h2 className="section-title">Agent</h2>
      <div className="card-list">
        <EntityRow to="/settings/digest" icon={<IconTile accent>{SettingsIcons.digest}</IconTile>} title="Digest" subtitle={digestSub} trailing={chevron} />
        <EntityRow to="/settings/push" icon={<IconTile accent>{SettingsIcons.push}</IconTile>} title="Push notifications" subtitle={pushSub} trailing={chevron} />
        <EntityRow to="/settings/agent" icon={<IconTile accent>{SettingsIcons.agent}</IconTile>} title="Agent" subtitle={agentSub} trailing={chevron} />
        <EntityRow
          to="/settings/privacy"
          icon={<IconTile accent>{SettingsIcons.privacy}</IconTile>}
          title="Privacy"
          subtitle={privacySub ?? 'Pseudonymization, exclusions, hidden people'}
          trailing={chevron}
        />
        <EntityRow
          to="/settings/learned"
          icon={<IconTile accent>{SettingsIcons.learned}</IconTile>}
          title="What I’ve learned"
          subtitle="What the ranker learned from your feedback, with resets"
          trailing={chevron}
        />
      </div>

      <h2 className="section-title">People</h2>
      <div className="card-list">
        <EntityRow
          to="/settings/privacy"
          icon={<IconTile>{SettingsIcons.hidden}</IconTile>}
          title="Hidden people"
          subtitle="Kept out of every list, search and suggestion; listed only under Privacy"
          trailing={chevron}
        />
      </div>

      <h2 className="section-title" id="calendars">
        Calendars
      </h2>
      <GoogleCalendarPanel />

      <h2 className="section-title">Quality</h2>
      <div className="card-list">
        <EntityRow
          to="/settings/eval"
          icon={<IconTile>{SettingsIcons.eval}</IconTile>}
          title="Eval"
          subtitle="Label a small golden set so changes to the agent can be measured"
          trailing={chevron}
        />
        <EntityRow to="/sources" icon={<IconTile>{Icons.sources}</IconTile>} title="Sources" subtitle="Ingest health and freshness" trailing={chevron} />
      </div>
    </>
  );
}
