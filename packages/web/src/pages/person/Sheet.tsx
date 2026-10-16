import { useEffect, useId, useRef, type ReactNode } from 'react';
import './ui.css';

/**
 * A modal sheet on the native <dialog> (focus trap and Esc for free): a bottom sheet on phones, a centered card on
 * wider screens. Used for evidence popovers, pickers and small editors.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  actions,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog yb-sheet wide' : 'dialog yb-sheet'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A tap on the backdrop (the dialog element itself, outside its content) closes it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog-body">
            <div className="sheet-head">
              <h2 id={titleId}>{title}</h2>
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Close" onClick={onClose}>
                ✕
              </button>
            </div>
            {children}
          </div>
          {actions && <div className="dialog-actions">{actions}</div>}
        </>
      )}
    </dialog>
  );
}
