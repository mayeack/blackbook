import { useState } from 'react';
import { Link } from 'react-router';
import { useToast } from '../../components/Toast';
import { useStarters } from './api';
import { evidenceHref, evidenceLabel } from './logic';
import { QuerySection } from './Section';

/** Copies text; false when the browser refuses (insecure context, permissions). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Conversation starters: drafts to copy into your own messages app. There is no send path anywhere — the label
 * says so, and the only action is Copy.
 */
export function StartersSection({ personId }: { personId: string }) {
  const q = useStarters(personId);
  const toast = useToast();
  const [copied, setCopied] = useState<number | null>(null);
  return (
    <QuerySection title="Conversation starters" query={q} hideWhenUnavailable>
      {(d) =>
        d.starters.length === 0 ? (
          <p className="caption">No starters yet. They’re drafted from what you know about each other.</p>
        ) : (
          <div className="card starters">
            <p className="caption starters-note">Drafts only · never sent. Copy one into your own messages if you like it.</p>
            <ol className="starter-list">
              {d.starters.slice(0, 3).map((s, i) => (
                <li key={i} className="starter">
                  <p className="starter-text">{s.text}</p>
                  <div className="starter-foot">
                    <span className="chips">
                      {s.basis.slice(0, 2).map((b) => {
                        const href = evidenceHref(b);
                        const label = evidenceLabel(b);
                        return href ? (
                          <Link key={b.ref} to={href} className="chip plain">
                            <span>{label}</span>
                          </Link>
                        ) : (
                          <span key={b.ref} className="chip plain">
                            <span>{label}</span>
                          </span>
                        );
                      })}
                      {s.source === 'template' && <span className="badge">Template</span>}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        void copyText(s.text).then((ok) => {
                          if (ok) {
                            setCopied(i);
                            window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 2000);
                          } else toast('Couldn’t copy. Select the text and copy it instead.', 'error');
                        })
                      }
                    >
                      {copied === i ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )
      }
    </QuerySection>
  );
}
