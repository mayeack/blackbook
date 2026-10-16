import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'info' | 'error';
interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-2), { id, message, kind }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={t.kind === 'error' ? 'toast error' : 'toast'}>
            <span>{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
