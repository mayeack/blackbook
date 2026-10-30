/**
 * Navigation handling for the service worker: network first, always. The last good app shell is kept only as an
 * offline fallback, and any sign of a signed-out session (Access redirect, 401/403, a visit to Access's logout)
 * deletes it, so a stale authenticated shell is never served after logout. Redirects pass straight through to the
 * browser, which follows them to the Access login.
 */
export const SHELL_CACHE = 'yb-shell-v1';
export const SHELL_KEY = '/__yb-shell';

export interface ShellStore {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface NavigationDeps {
  fetch: (req: Request) => Promise<Response>;
  store: () => Promise<ShellStore>;
  offline: () => Response;
}

/** Cloudflare Access endpoints (login callback, logout) are never handled or cached. */
export const isAccessPath = (pathname: string) => pathname.startsWith('/cdn-cgi/');

/**
 * The event-picks ticket link (/go/<id>): the server redirects it to a ticket site, which is not a sign of a
 * signed-out session, so the worker leaves it alone instead of dropping the shell.
 */
export const isTicketRedirect = (pathname: string) => pathname.startsWith('/go/');

/** Same-origin page navigations the worker answers (never API calls, health, Access endpoints or ticket redirects). */
export function shouldHandle(url: URL, origin: string, mode: string, method: string): boolean {
  if (mode !== 'navigate' || method !== 'GET' || url.origin !== origin) return false;
  return !url.pathname.startsWith('/api/') && url.pathname !== '/healthz' && !isAccessPath(url.pathname) && !isTicketRedirect(url.pathname);
}

export const signedOut = (res: Response) =>
  res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403;

const isShell = (res: Response) =>
  res.ok && res.type === 'basic' && (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html');

export async function handleNavigation(req: Request, deps: NavigationDeps): Promise<Response> {
  const store = await deps.store();
  let res: Response;
  try {
    res = await deps.fetch(req);
  } catch {
    return (await store.match(SHELL_KEY)) ?? deps.offline();
  }
  if (signedOut(res)) await store.delete(SHELL_KEY);
  else if (isShell(res)) await store.put(SHELL_KEY, res.clone());
  return res;
}

export const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>yeackbot · offline</title>
<style>
:root{color-scheme:light dark;--bg:#f8f7f3;--fg:#12110d;--mu:#6d6a61}
@media (prefers-color-scheme:dark){:root{--bg:#11110f;--fg:#f6f4ee;--mu:#9c988c}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:15px/1.4 system-ui,-apple-system,sans-serif;padding:16px;text-align:center}
p{color:var(--mu)}
</style></head><body><main><h1>You’re offline</h1><p>yeackbot needs a connection. Reconnect, then reload.</p></main></body></html>`;
