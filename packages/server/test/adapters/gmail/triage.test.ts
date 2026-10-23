/**
 * Ticket-mail triage on metadata (adapters/gmail/triage.ts): transactional vendor mail is a candidate, the marketing
 * traps from the design are not, non-vendor mail needs a pass or a forward, the owner's own mail is ignored; and the
 * list queries Gmail filters with.
 */
import { describe, expect, it } from 'vitest';
import { listQuery, passQuery, triage, type TriageInput } from '../../../src/adapters/gmail/triage';
import { senderAddress, senderDomain, vendorEventIdOf, vendorOf, VENDORS } from '../../../src/adapters/gmail/vendors';
import { addr, matches } from './fakeGmail';

const vendorMail = (subject: string, extra: Partial<TriageInput> = {}): TriageInput => ({
  from: `Ticketmaster <${addr('customer_support', 'email.ticketmaster.com')}>`,
  subject,
  labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
  fromDomain: 'email.ticketmaster.com',
  hasPass: false,
  fromOwner: false,
  ...extra,
});
const otherMail = (subject: string, extra: Partial<TriageInput> = {}): TriageInput => ({
  from: `Rowan Quill <${addr('rowan.quill', 'example.com')}>`,
  subject,
  labelIds: ['INBOX'],
  fromDomain: 'example.com',
  hasPass: false,
  fromOwner: false,
  ...extra,
});
const verdict = (t: TriageInput, extra: string[] = []) => triage(t, extra).verdict;

describe('triage verdicts', () => {
  it('transactional vendor subjects are candidates (orders, deliveries, transfers, resale, refunds, changes)', () => {
    for (const s of [
      'Your Order Confirmation',
      'Order #12-34567/NY is confirmed',
      'Your tickets are ready',
      'Your mobile tickets for Lumen Arcade',
      'Dana Reyes sent you 2 tickets',
      'Dana accepted your ticket transfer',
      'Your tickets are on its way to Dana',
      'Your tickets have sold!',
      'Your refund has been processed',
      'Event cancelled: Lumen Arcade',
      'Important update about your event',
      'Lumen Arcade has been rescheduled',
      "You're going to Lumen Arcade",
      'Reminder: your event is tomorrow!',
      'Know before you go: The Copper Hall',
      'Add to Apple Wallet: your tickets',
      // Reminders that prove he still holds tickets (checked against real subject shapes, 2026-10-21).
      'Instructions For Mobile Entry Into Lumen Arcade',
      'Important Ticket Instructions for Your Upcoming Lumen Arcade Event',
      '10:00 PM today: Lumen Arcade',
      'Lumen Arcade - Just 7 Days Away',
      'Get Ready For Lumen Arcade Tomorrow',
    ]) {
      expect(verdict(vendorMail(s)), s).toBe('candidate');
    }
  });

  it('the marketing traps from vendor domains are marketing, never candidates', () => {
    for (const s of [
      'Presale starts tomorrow: Lumen Arcade',
      'On sale now: Halcy Drift',
      'Just Announced: Night Signals Tour',
      'Wait list: Lumen Arcade at The Copper Hall',
      'Buy now: last tickets for Saturday',
      "You're invited to the Halcy Drift fan presale",
      'How was Lumen Arcade? Tell us',
      'Rate your experience at The Copper Hall',
      'Lumen Arcade tomorrow!',
      'Want to see Halcy Drift again?',
      'Get your tickets before they are gone',
      'Your weekend: 10 shows near you',
      'Recommended for you: new concerts',
    ]) {
      expect(verdict(vendorMail(s)), s).toBe('marketing');
    }
    // A vendor subject that is neither still isn't a candidate.
    expect(triage(vendorMail('Lumen Arcade at The Copper Hall'))).toMatchObject({ verdict: 'marketing', rule: 'vendor_other' });
  });

  it('non-vendor mail: a ticket subject needs a pass / .ics part; a forwarded ticket subject or a registration is enough', () => {
    expect(verdict(otherMail('Free tickets inside: Design Meetup'))).toBe('ignored');
    expect(triage(otherMail('Free tickets inside: Design Meetup', { hasPass: true }))).toMatchObject({ verdict: 'candidate', rule: 'pass_registration' });
    // A registration confirmation or an RSVP reminder names an event he signed up for, whoever sends it.
    expect(triage(otherMail('Design Expo 2027: Registration Confirmation'))).toMatchObject({ verdict: 'candidate', rule: 'registration' });
    expect(triage(otherMail('RSVP Reminder: Harvest Supper Social'))).toMatchObject({ verdict: 'candidate', rule: 'registration' });
    expect(triage(otherMail('Thank you for registering for Design Meetup'))).toMatchObject({ verdict: 'candidate', rule: 'registration' });
    expect(verdict(otherMail('Will you RSVP for the neighborhood cleanup?'))).toBe('ignored');
    expect(triage(otherMail('Fwd: Your tickets for Lumen Arcade'))).toMatchObject({ verdict: 'candidate', rule: 'forwarded_ticket', forwarded: true });
    expect(verdict(otherMail('Fwd: presale code for Lumen Arcade'))).toBe('ignored');
    expect(verdict(otherMail('Lunch on Friday?', { hasPass: true }))).toBe('ignored');
    expect(verdict(otherMail('Re: tickets for Saturday?'))).toBe('ignored');
  });

  it("the owner's own mail (sent, drafts, his address) is ignored even from a vendor-looking subject", () => {
    expect(triage(vendorMail('Your Order Confirmation', { labelIds: ['SENT'] }))).toMatchObject({ verdict: 'ignored', rule: 'own_mail' });
    expect(verdict(vendorMail('Your Order Confirmation', { labelIds: ['DRAFT'] }))).toBe('ignored');
    expect(verdict(otherMail('Fwd: Your tickets for Lumen Arcade', { fromOwner: true }))).toBe('ignored');
  });

  it('extra senders from the setting count as vendors (their own vendor name)', () => {
    const t = otherMail('Your order confirmation', { fromDomain: 'box.venue.example' });
    expect(verdict(t)).toBe('ignored');
    expect(triage(t, ['venue.example'])).toMatchObject({ verdict: 'candidate', vendor: { name: 'venue.example' } });
    // A listed sender (his club) mails event titles as subjects: any subject but marketing is a candidate.
    expect(triage(otherMail('Harvest Supper Social', { fromDomain: 'club.example' }), ['club.example'])).toMatchObject({ verdict: 'candidate', rule: 'extra_sender' });
    expect(triage(otherMail('Our new menu is on sale now', { fromDomain: 'club.example' }), ['club.example'])).toMatchObject({ verdict: 'marketing' });
  });
});

describe('vendors', () => {
  it('matches subdomains, never look-alikes, and reads sender domains without keeping addresses', () => {
    expect(vendorOf('email.ticketmaster.com')?.name).toBe('ticketmaster');
    expect(vendorOf('ticketmaster.com.example')).toBeNull();
    expect(vendorOf('notticketmaster.com')).toBeNull();
    expect(vendorOf('orders.stubhub.com')).toMatchObject({ name: 'stubhub', secondary: true });
    expect(senderDomain(`Tickets <${addr('noreply', 'Tickets.Example')}>`)).toBe('tickets.example');
    expect(senderDomain(addr('a', 'b.example'))).toBe('b.example');
    expect(senderDomain('no address here')).toBeNull();
    expect(senderAddress(`X <${addr('Sam.Owner', 'example.com')}>`)).toBe(addr('sam.owner', 'example.com'));
    expect(VENDORS.every((v) => v.domains.every((d) => d === d.toLowerCase() && !d.includes('@')))).toBe(true);
  });

  it('event ids come only from the vendor’s own event URLs', () => {
    const tm = vendorOf('ticketmaster.com')!;
    expect(vendorEventIdOf('https://www.ticketmaster.com/lumen-arcade/event/0B00ABCD12345678?ref=x', tm)).toBe('ticketmaster:0b00abcd12345678');
    expect(vendorEventIdOf('https://www.ticketmaster.com/help', tm)).toBeNull();
    expect(vendorEventIdOf('https://tickets.example/event/0B00ABCD12345678', tm)).toBeNull();
    expect(vendorEventIdOf('https://www.eventbrite.com/e/design-meetup-tickets-123456789012', vendorOf('eventbrite.com')!)).toBe('eventbrite:123456789012');
    expect(vendorEventIdOf('https://tickets.example/events/lumen-arcade-1107', vendorOf('tickets.example', ['tickets.example'])!)).toBe('tickets.example:lumen-arcade-1107');
  });
});

describe('list queries', () => {
  const from = Date.UTC(2026, 9, 1);
  const to = Date.UTC(2026, 9, 21);

  it('the main query ORs vendor senders, ticket subjects and passes; never the owner’s sent mail', () => {
    const q = listQuery({ from, to }, ['venue.example']);
    expect(q).toMatch(new RegExp(`^after:${from / 1000} before:${to / 1000} -in:sent -in:drafts -in:chats \\{`));
    expect(q).toContain('from:ticketmaster.com');
    expect(q).toContain('from:venue.example');
    expect(q).toContain('subject:tickets');
    expect(q).toContain('filename:pkpass');
    expect(listQuery({ from, to: null })).not.toContain('before:');
    const spec = (o: Partial<Parameters<typeof matches>[1]>) => ({ at: from + 1000, from: `X <${addr('a', 'example.com')}>`, subject: 'Hello', ...o });
    expect(matches(q, spec({ from: `TM <${addr('x', 'email.ticketmaster.com')}>` }))).toBe(true);
    expect(matches(q, spec({ subject: 'Your tickets' }))).toBe(true);
    expect(matches(q, spec({}))).toBe(false);
    expect(matches(q, spec({ subject: 'Your tickets', labelIds: ['SENT'] }))).toBe(false);
    expect(matches(q, spec({ subject: 'Your tickets', at: to + 1000 }))).toBe(false);
  });

  it('the pass query needs a pass or .ics part AND a ticket-ish subject', () => {
    const q = passQuery({ from, to: null });
    const spec = (o: Partial<Parameters<typeof matches>[1]>) => ({ at: from + 1000, from: `X <${addr('a', 'example.com')}>`, subject: 'Registration confirmed', ...o });
    expect(matches(q, spec({ attachments: [{ filename: 'invite.ics', mimeType: 'text/calendar' }] }))).toBe(true);
    expect(matches(q, spec({}))).toBe(false);
    expect(matches(q, spec({ subject: 'Team sync', attachments: [{ filename: 'invite.ics', mimeType: 'text/calendar' }] }))).toBe(false);
  });
});
