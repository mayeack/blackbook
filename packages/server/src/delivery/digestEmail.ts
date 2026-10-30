/**
 * The morning brief as one email to the owner's own Gmail (owner request 2026-10-30: "Also send my daily digest via
 * email"; delivery/email.ts sends it, From = To = his connected address). It carries what the text carries
 * (compose.ts), so the two never disagree:
 *
 *   Subject   Your brief for Fri Oct 30: 3 things
 *   greeting  "Good morning! 3 things for today."
 *   items     each: the numbered line, its context, its details, the opener draft; a sensitive item stays
 *             "Something personal / The details are in the app.", as in the text
 *   health    the ≤1 "Heads up" line
 *   closing   "That's it! It's all at https://yeackbot.com/today" (replying to an email does nothing, so no
 *             "Reply done 2")
 * Each item's lines pass the same outbound rules as the text (no phone numbers, emails, or links but yeackbot.com)
 * or fall back to "N. One for you in the app."; everything is HTML-escaped. Pure functions.
 */
import { closing, greeting, passesOutbound, safeItemLines } from './compose';
import type { EmailMessage } from './email';
import { headerDate, plural, TODAY_LINK } from './text';

export interface BriefEmailInput {
  localDate: string;
  /** The composed items (ComposedDigest.items) still visible today. */
  items: readonly Parameters<typeof safeItemLines>[0][];
  health: string | null;
  /** settings digest.time: picks the greeting. */
  digestTime?: string;
}

const url = (path: string) => `https://${path}`;
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The closing without its link ("That's it! It's all at"), so text and HTML can each link it their way. */
const CLOSING_LEAD = closing([], false)[0]!.replace(TODAY_LINK, '').trimEnd();

export function briefEmailSubject(i: Pick<BriefEmailInput, 'localDate' | 'items'>): string {
  return `Your brief for ${headerDate(i.localDate)}: ${plural(i.items.length, 'thing')}`;
}

const healthOf = (i: BriefEmailInput): string | null => (i.health && passesOutbound([i.health]) ? i.health : null);

export function briefEmailText(i: BriefEmailInput): string {
  const out = [greeting(i.items.length, i.digestTime)];
  for (const item of i.items) out.push('', ...safeItemLines(item));
  const health = healthOf(i);
  if (health) out.push('', health);
  out.push('', `${CLOSING_LEAD} ${url(TODAY_LINK)}`);
  return out.join('\n');
}

const C = { text: '#1d1d1f', muted: '#6e6e73', line: '#e5e5ea', accent: '#0a66c2', bg: '#ffffff' };

function itemHtml(lines: string[]): string {
  const [head, ...rest] = lines;
  const sub = rest.map((x) => `<div style="margin-top:2px;color:${C.muted};font-size:14px;line-height:20px">${esc(x)}</div>`).join('');
  return (
    `<tr><td style="padding:14px 0;border-top:1px solid ${C.line}">` +
    `<div style="font-size:16px;line-height:22px;font-weight:600;color:${C.text}">${esc(head ?? '')}</div>${sub}` +
    `</td></tr>`
  );
}

export function briefEmailHtml(i: BriefEmailInput): string {
  const items = i.items.map((item) => itemHtml(safeItemLines(item))).join('');
  const health = healthOf(i);
  const healthHtml = health ? `<tr><td style="padding:14px 0;border-top:1px solid ${C.line};color:${C.text};font-size:14px;line-height:20px">${esc(health)}</td></tr>` : '';
  const close =
    `<tr><td style="padding:18px 0 0;border-top:1px solid ${C.line};color:${C.muted};font-size:14px;line-height:20px">${esc(CLOSING_LEAD)} ` +
    `<a href="${esc(url(TODAY_LINK))}" style="color:${C.accent};font-weight:600;text-decoration:none">${esc(TODAY_LINK)}</a></td></tr>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>` +
    `<body style="margin:0;padding:0;background:${C.bg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
    `<tr><td style="padding-bottom:10px;font-size:22px;line-height:28px;font-weight:700;color:${C.text}">${esc(greeting(i.items.length, i.digestTime))}</td></tr>` +
    `${items}${healthHtml}${close}` +
    `</table></td></tr></table></body></html>`
  );
}

export function briefEmail(i: BriefEmailInput): EmailMessage {
  return { subject: briefEmailSubject(i), text: briefEmailText(i), html: briefEmailHtml(i), tag: 'daily-brief' };
}
