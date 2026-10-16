import { useEffect, useRef, type ReactNode } from 'react';
import './ui.css';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A small ⋯ menu on <details> (keyboard and screen-reader friendly, closes on outside tap and after a choice). */
export function MoreMenu({ items, label = 'More actions', icon = '⋯' }: { items: MenuItem[]; label?: string; icon?: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      const d = ref.current;
      if (d?.open && !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return (
    <details ref={ref} className="yb-menu">
      <summary className="btn btn-sm btn-ghost" aria-label={label} title={label}>
        {icon}
      </summary>
      <div className="yb-menu-list" role="menu">
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={it.danger ? 'danger' : undefined}
            disabled={it.disabled}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </details>
  );
}
