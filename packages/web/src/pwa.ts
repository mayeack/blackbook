/**
 * Registers /sw.js (production builds only). Registered from here rather than vite-plugin-pwa's injected snippet
 * because the CSP allows no inline scripts. updateViaCache 'none' always revalidates the worker script.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // Not fatal: the app works without it (no offline shell, no push).
    });
  });
}
