import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A small popover menu (the ⋯ and Snooze buttons). Closes on outside tap, Escape or a choice. */
export function ActionMenu({
  label,
  items,
  ariaLabel,
  className = 'btn btn-sm',
  align = 'end',
}: {
  label: ReactNode;
  items: MenuItem[];
  ariaLabel?: string;
  className?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div className="td-menu-wrap" ref={ref}>
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div className={align === 'end' ? 'td-menu' : 'td-menu start'} role="menu" id={id}>
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              className={i.danger ? 'danger' : undefined}
              disabled={i.disabled}
              onClick={() => {
                setOpen(false);
                i.onSelect();
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
