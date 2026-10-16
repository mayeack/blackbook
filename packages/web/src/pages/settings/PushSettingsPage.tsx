/**
 * Settings → Push: enable push on this device (service worker + VAPID subscription), test push (owner's own
 * devices only), the subscribed devices, and the push settings. Notifications are generic: no names unless the
 * owner turns that on, and tapping one opens Today.
 */
import { useEffect, useState } from 'react';
import { isApiError } from '../../api/client';
import { isNotImplemented } from '../../api/hooks';
import { EntityRow, IconTile } from '../../components/EntityRow';
import { Empty, PageState } from '../../components/PageState';
import { useToast } from '../../components/Toast';
import { plural, relativeDay } from '../../lib/format';
import { usePushDevices, usePushSubscribe, usePushTest, usePushUnsubscribe, usePushVapid } from './api';
import { fieldId, SectionTitle, SettingRow, SettingsFrame, Toggle, useSettingsForm, type SettingsForm } from './form';
import { SettingsIcons } from './icons';
import { browserPushEnv, pushSupport, rememberThisDevice, subscribeThisDevice, thisDeviceId, type PushSupport } from './push';

const SUPPORT_COPY: Record<Exclude<PushSupport, 'ready'>, { title: string; body: string }> = {
  unsupported: { title: 'This browser can’t do web push.', body: 'Try Safari or Chrome on a phone or computer.' },
  needs_install: {
    title: 'Add yeackbot to your Home Screen first.',
    body: 'On iPhone and iPad, push works only in the installed app: tap Share → Add to Home Screen, open yeackbot from there, and come back here.',
  },
  no_worker: { title: 'The app’s service worker isn’t running.', body: 'Push needs the installed production app (development builds don’t register one). Reload once and try again.' },
  denied: { title: 'Notifications are blocked for yeackbot.', body: 'Allow notifications for this site in your browser or system settings, then come back.' },
};

/** This device's registration + subscription, read once (and after changes). */
function useThisDevice() {
  const [state, setState] = useState<{ support: PushSupport; endpoint: string | null; loading: boolean }>({ support: 'unsupported', endpoint: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      let reg: ServiceWorkerRegistration | undefined;
      try {
        reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
      } catch {
        reg = undefined;
      }
      const support = pushSupport(browserPushEnv(Boolean(reg)));
      let endpoint: string | null = null;
      try {
        endpoint = (await reg?.pushManager?.getSubscription())?.endpoint ?? null;
      } catch {
        endpoint = null;
      }
      if (live) setState({ support, endpoint, loading: false });
    })();
    return () => {
      live = false;
    };
  }, [tick]);
  return { ...state, refresh: () => setTick((t) => t + 1) };
}

function ThisDevice() {
  const vapid = usePushVapid();
  const subscribe = usePushSubscribe();
  const unsubscribe = usePushUnsubscribe();
  const test = usePushTest();
  const toast = useToast();
  const dev = useThisDevice();
  const [busy, setBusy] = useState(false);

  if (dev.loading || (!vapid.data && !vapid.error)) return <PageState error={null} />;
  if (!vapid.data) {
    if (isNotImplemented(vapid.error)) return <Empty title="Push isn’t available on this server yet." />;
    return <PageState error={vapid.error} onRetry={() => void vapid.refetch()} />;
  }
  if (!vapid.data.configured || !vapid.data.publicKey)
    return (
      <Empty title="Push isn’t set up on the server yet.">
        The server needs VAPID keys (SECRETS_KEY or VAPID_* in its .env). Nothing on this device needs to change.
      </Empty>
    );
  if (dev.support !== 'ready') {
    const c = SUPPORT_COPY[dev.support];
    return <Empty title={c.title}>{c.body}</Empty>;
  }

  const enable = async () => {
    setBusy(true);
    try {
      const out = await subscribeThisDevice(vapid.data.publicKey, {
        requestPermission: () => Notification.requestPermission(),
        getRegistration: async () => (await navigator.serviceWorker.getRegistration()) ?? null,
        post: (body) => subscribe.mutateAsync(body),
        userAgent: navigator.userAgent,
      });
      if (out.ok) {
        rememberThisDevice(out.id);
        toast('Push is on for this device.');
      } else {
        toast(
          out.reason === 'denied'
            ? 'Notifications weren’t allowed.'
            : out.reason === 'no_worker'
              ? 'The service worker isn’t running. Reload and try again.'
              : 'Couldn’t subscribe this device.',
          'error',
        );
      }
    } catch (e) {
      toast(isApiError(e) ? e.message : 'Couldn’t subscribe this device.', 'error');
    } finally {
      setBusy(false);
      dev.refresh();
    }
  };

  const disable = async () => {
    if (!dev.endpoint) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      await unsubscribe.mutateAsync(dev.endpoint);
      await sub?.unsubscribe().catch(() => false);
      rememberThisDevice(null);
      toast('Push is off for this device.');
    } catch (e) {
      toast((e as Error).message || 'Couldn’t turn push off here.', 'error');
    } finally {
      setBusy(false);
      dev.refresh();
    }
  };

  const sendTest = () =>
    test.mutate(dev.endpoint ? { endpoint: dev.endpoint } : {}, {
      onSuccess: (r) =>
        toast(
          r.sent ? `Test sent${r.failed ? ` · ${r.failed} failed` : ''}${r.removed ? ` · ${plural(r.removed, 'dead device')} removed` : ''}.` : 'No test went out.',
          r.sent ? 'info' : 'error',
        ),
      onError: (e) => toast(e.message, 'error'),
    });

  return (
    <div className="st-device">
      <p className="st-lead">
        {dev.endpoint ? 'This device gets yeackbot notifications.' : 'Get a ping on this device when your brief is ready.'}
        {Notification.permission === 'granted' ? '' : ' Your browser will ask for permission.'}
      </p>
      <div className="st-actions">
        {dev.endpoint ? (
          <>
            <button type="button" className="btn btn-primary" disabled={test.isPending} onClick={sendTest}>
              {test.isPending ? 'Sending…' : 'Send a test push'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void disable()}>
              Turn off on this device
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void enable()} title="Re-register this device with the server">
              Re-register
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void enable()}>
            {busy ? 'Enabling…' : 'Enable on this device'}
          </button>
        )}
      </div>
    </div>
  );
}

function Devices() {
  const q = usePushDevices();
  const test = usePushTest();
  const toast = useToast();
  const mine = thisDeviceId();
  if (!q.data) {
    if (isNotImplemented(q.error)) return null;
    return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const devices = q.data.devices;
  return (
    <>
      <div className="card-list">
        {devices.length === 0 ? (
          <Empty title="No devices yet.">Enable push on a phone or computer to see it here.</Empty>
        ) : (
          devices.map((d) => (
            <EntityRow
              key={d.id}
              icon={<IconTile>{SettingsIcons.push}</IconTile>}
              title={
                <>
                  {d.userAgent ?? 'Device'}
                  {d.id === mine && <span className="pill pill-accent st-inline-pill">This device</span>}
                </>
              }
              subtitle={[
                d.endpointHost,
                `added ${relativeDay(d.createdAt)}`,
                d.lastOkAt != null ? `last delivered ${relativeDay(d.lastOkAt)}` : 'nothing delivered yet',
                d.failures ? plural(d.failures, 'failure') : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          ))
        )}
      </div>
      {devices.length > 0 && (
        <p>
          <button
            type="button"
            className="btn btn-block"
            disabled={test.isPending}
            onClick={() =>
              test.mutate({}, { onSuccess: (r) => toast(`Test sent to ${plural(r.sent, 'device')}.`), onError: (e) => toast(e.message, 'error') })
            }
          >
            {devices.length > 1 ? `Send a test to all ${devices.length} devices` : 'Send a test to your device'}
          </button>
        </p>
      )}
    </>
  );
}

function PushForm({ form }: { form: SettingsForm }) {
  const v = form.values;
  return (
    <>
      <SectionTitle>This device</SectionTitle>
      <div className="card st-card">
        <ThisDevice />
      </div>

      <SectionTitle>Notifications</SectionTitle>
      <div className="card st-card">
        <SettingRow form={form} k="push.enabled" description="Ping your subscribed devices when the brief is ready and for critical source problems.">
          <Toggle id={fieldId('push.enabled')} checked={v['push.enabled']} onChange={(x) => form.set('push.enabled', x)} />
        </SettingRow>
        <SettingRow form={form} k="push.names_in_notifications">
          <Toggle id={fieldId('push.names_in_notifications')} checked={v['push.names_in_notifications']} onChange={(x) => form.set('push.names_in_notifications', x)} />
        </SettingRow>
        <SettingRow form={form} k="push.pre_event">
          <Toggle id={fieldId('push.pre_event')} checked={v['push.pre_event']} onChange={(x) => form.set('push.pre_event', x)} />
        </SettingRow>
        <p className="caption st-lead">Lock-screen text stays generic (“Your brief is ready · 4 things”). Tapping a notification opens Today.</p>
      </div>

      <SectionTitle>Subscribed devices</SectionTitle>
      <Devices />
    </>
  );
}

export function PushSettingsPage() {
  const { form, query } = useSettingsForm();
  return (
    <SettingsFrame title="Push" sub="Notifications on your phone and computer" form={form} query={query}>
      {(f) => <PushForm form={f} />}
    </SettingsFrame>
  );
}
