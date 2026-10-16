/** Settings row icons (24-unit grid, currentColor; same style as components/icons). */
const icon = (d: string, size = 20) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SettingsIcons = {
  digest: icon('M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12zM8.5 10h7M8.5 13.5h4.5'),
  push: icon('M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0'),
  agent: icon('M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4'),
  privacy: icon('M6 10h12v10H6zM8.5 10V7.5a3.5 3.5 0 0 1 7 0V10M12 14v2.5'),
  learned: icon('M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z'),
  eval: icon('M9 11l2.5 2.5L16 9M5 4h14v16H5z'),
  hidden: icon('M3 12s3.5-6 9-6c2 0 3.7.8 5 1.8M21 12s-3.5 6-9 6c-2 0-3.7-.8-5-1.8M4 20L20 4'),
};
