/**
 * Settings form plumbing shared by the sub-pages: a draft over GET /settings, per-field + cross-field validation,
 * one PATCH per Save (one undoable journal batch), and the row/controls/save bar.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { SettingKey, SettingMeta, SettingsResponse } from '@yb/shared';
import { PageHeader, PageState } from '../../components/PageState';
import { useToast } from '../../components/Toast';
import { plural } from '../../lib/format';
import { usePatchSettings, useSettings } from './api';
import {
  buildPatch,
  crossFieldErrors,
  dirtyKeys,
  mergeDraft,
  numberBounds,
  serverFieldErrors,
  validateField,
  type Draft,
  type FieldErrors,
  type Values,
} from './logic';
import './settings.css';

export interface SettingsForm {
  data: SettingsResponse;
  values: Values;
  set: <K extends SettingKey>(key: K, value: Values[K]) => void;
  reset: (key: SettingKey) => void;
  errors: FieldErrors;
  dirty: SettingKey[];
  isDirty: (key: SettingKey) => boolean;
  meta: (key: SettingKey) => SettingMeta | undefined;
  save: () => void;
  /** Saves these values right away (one batch), ignoring the rest of the draft. */
  saveNow: (values: Draft, done: string) => void;
  discard: () => void;
  saving: boolean;
}

export function useSettingsForm(): { form: SettingsForm | null; query: ReturnType<typeof useSettings> } {
  const query = useSettings();
  const patch = usePatchSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({});
  const [resets, setResets] = useState<Set<SettingKey>>(() => new Set());
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const data = query.data;
  const overridden = useMemo(() => new Set((data?.meta ?? []).filter((m) => m.overridden).map((m) => m.key)), [data]);

  if (!data) return { form: null, query };
  const values = mergeDraft(data.values, data.defaults, draft, resets);
  const dirty = dirtyKeys(data.values, draft, resets, overridden);
  // Field errors win over cross-field ones; cross-field rules only matter once something changed.
  const fieldErrors: FieldErrors = {};
  for (const k of Object.keys(draft) as SettingKey[]) {
    const msg = validateField(k, draft[k]);
    if (msg) fieldErrors[k] = msg;
  }
  const errors: FieldErrors = { ...(dirty.length ? crossFieldErrors(values) : {}), ...serverErrors, ...fieldErrors };

  const clearServerError = (k: SettingKey) =>
    setServerErrors((e) => {
      if (!(k in e)) return e;
      const { [k]: _gone, ...rest } = e;
      return rest;
    });

  const form: SettingsForm = {
    data,
    values,
    errors,
    dirty,
    isDirty: (k) => dirty.includes(k),
    meta: (k) => data.meta.find((m) => m.key === k),
    set: (k, v) => {
      setDraft((d) => ({ ...d, [k]: v }));
      setResets((r) => {
        if (!r.has(k)) return r;
        const next = new Set(r);
        next.delete(k);
        return next;
      });
      clearServerError(k);
    },
    reset: (k) => {
      setDraft(({ [k]: _gone, ...rest }) => rest);
      setResets((r) => new Set(r).add(k));
      clearServerError(k);
    },
    save: () => {
      const p = buildPatch(data.values, draft, resets, overridden);
      if (!p) return;
      patch.mutate(p, {
        onSuccess: (r) => {
          setDraft({});
          setResets(new Set());
          setServerErrors({});
          toast(r.changed.length ? `Saved ${plural(r.changed.length, 'setting')}. Undo from Today if you need to.` : 'Nothing changed.');
        },
        onError: (e) => {
          setServerErrors(serverFieldErrors(e));
          toast(e.message, 'error');
        },
      });
    },
    saveNow: (vals, done) =>
      patch.mutate(
        { values: vals },
        {
          onSuccess: () => {
            setDraft((d) => {
              const next = { ...d };
              for (const k of Object.keys(vals) as SettingKey[]) delete next[k];
              return next;
            });
            toast(done);
          },
          onError: (e) => toast(e.message, 'error'),
        },
      ),
    discard: () => {
      setDraft({});
      setResets(new Set());
      setServerErrors({});
    },
    saving: patch.isPending,
  };
  return { form, query };
}

/** Sub-page frame: back link, title, loading/error, the save bar. */
export function SettingsFrame({ title, sub, form, query, children }: {
  title: string;
  sub?: ReactNode;
  form: SettingsForm | null;
  query: ReturnType<typeof useSettings>;
  children: (form: SettingsForm) => ReactNode;
}) {
  return (
    <>
      <Link to="/settings" className="back-link">
        ‹ Settings
      </Link>
      <PageHeader title={title} sub={sub} />
      {form ? (
        <>
          {children(form)}
          <SaveBar form={form} />
        </>
      ) : (
        <PageState error={query.error} onRetry={() => void query.refetch()} />
      )}
    </>
  );
}

/** Sticky "N unsaved changes · Discard · Save" bar (above the mobile tab bar). Warns before leaving with changes. */
export function SaveBar({ form }: { form: SettingsForm }) {
  const n = form.dirty.length;
  const blocked = Object.keys(form.errors).length > 0;
  useEffect(() => {
    if (!n) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [n]);
  if (!n) return null;
  return (
    <div className="st-savebar" role="region" aria-label="Unsaved changes">
      <span className="st-savebar-text">{blocked ? 'Fix the highlighted fields to save.' : `${plural(n, 'unsaved change')}`}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={form.discard} disabled={form.saving}>
        Discard
      </button>
      <button type="button" className="btn btn-sm btn-primary" onClick={form.save} disabled={form.saving || blocked}>
        {form.saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

const fmtDefault = (v: unknown): string => {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (v == null) return 'none';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).join('–');
  return String(v);
};

/** One setting: label + description on the left, the control on the right (wraps below on narrow screens). */
export function SettingRow({
  form,
  k,
  label,
  description,
  children,
  showDefault = true,
  formatDefault = fmtDefault,
}: {
  form: SettingsForm;
  k: SettingKey;
  label?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  showDefault?: boolean;
  formatDefault?: (v: unknown) => string;
}) {
  const m = form.meta(k);
  const error = form.errors[k];
  const differs = JSON.stringify(form.values[k]) !== JSON.stringify(form.data.defaults[k]);
  const id = `st-${k.replace(/\W/g, '-')}`;
  return (
    <div className={error ? 'st-row has-error' : form.isDirty(k) ? 'st-row dirty' : 'st-row'}>
      <div className="st-text">
        <label className="st-label" htmlFor={id}>
          {label ?? m?.label ?? k}
          {form.isDirty(k) && <span className="st-dot" title="Unsaved" aria-label="unsaved" />}
        </label>
        {(description ?? m?.description) && <div className="st-desc">{description ?? m?.description}</div>}
        {showDefault && differs && (
          <div className="st-default">
            Default {formatDefault(form.data.defaults[k])} ·{' '}
            <button type="button" className="st-linkbtn" onClick={() => form.reset(k)}>
              Reset
            </button>
          </div>
        )}
        {error && (
          <div className="st-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="st-control" id={`${id}-control`}>
        {children}
      </div>
    </div>
  );
}

export const fieldId = (k: SettingKey) => `st-${k.replace(/\W/g, '-')}`;

export function Toggle({ id, checked, onChange, disabled, label }: { id?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <span className="st-switch">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="st-switch-track" aria-hidden />
    </span>
  );
}

/** Number input bound to a numeric setting (bounds from the shared schema). Typing keeps a local string. */
export function NumberField({ form, k, step, suffix }: { form: SettingsForm; k: SettingKey; step?: number; suffix?: string }) {
  const b = numberBounds(k);
  const value = form.values[k] as number;
  const [text, setText] = useState(String(value));
  useEffect(() => {
    // Follow outside changes (reset, discard, save) unless the field is mid-edit with the same number.
    setText((t) => ((t !== '' && Number(t) === value) || Number.isNaN(value) ? t : String(value)));
  }, [value]);
  return (
    <span className="st-num">
      <input
        id={fieldId(k)}
        className="input input-sm"
        type="number"
        inputMode={b.int ? 'numeric' : 'decimal'}
        min={b.min ?? undefined}
        max={b.max ?? undefined}
        step={step ?? (b.int ? 1 : 0.1)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          form.set(k, (e.target.value === '' ? Number.NaN : Number(e.target.value)) as never);
        }}
      />
      {suffix && <span className="caption">{suffix}</span>}
    </span>
  );
}

export function TimeField({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) {
  return <input id={id} className="input input-sm" type="time" step={300} value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="section-title">{children}</h2>;
}
