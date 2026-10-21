/**
 * Message cleaning (adapters/gmail/clean.ts): body choice (HTML-only, stubs, template dumps), HTML → text, the local
 * refs (vendor event id, order ref, JSON-LD allowlist, partiful ids, ticket counts, weekdays), transfer
 * counterparties, and everything that keeps names off the packet: the forward / reply cut, header lines, labelled
 * names, counterparties and the owner's own names. Synthetic mail only.
 */
import { describe, expect, it } from 'vitest';
import {
  cleanMessage,
  cutQuoted,
  dropHeaderLines,
  extractCounterparties,
  extractJsonLd,
  htmlToText,
  maskGreetings,
  maskLabelledNames,
  maskVocative,
  orderRefsIn,
  seatCount,
  weekdayHints,
} from '../../../src/adapters/gmail/clean';
import type { GmailPart } from '../../../src/adapters/gmail/api';
import { vendorOf } from '../../../src/adapters/gmail/vendors';
import type { OwnerName } from '../../../src/identity/ownerNames';
import { addr, orderHtml, payloadOf } from './fakeGmail';

const OWNER: OwnerName[] = [{ firstName: 'Sam', lastName: 'Varga', displayName: 'Sam Varga', nickname: 'Sammy' }];
const tm = vendorOf('ticketmaster.com')!;
const DANA_EMAIL = addr('dana.reyes', 'example.com');

const clean = (payload: GmailPart, o: { subject?: string; forwarded?: boolean; vendor?: typeof tm | null } = {}) =>
  cleanMessage({ subject: o.subject ?? 'Your order confirmation', payload, vendor: o.vendor === undefined ? tm : o.vendor, forwarded: o.forwarded ?? false, ownerNames: OWNER });

describe('bodies', () => {
  it('an HTML-only order becomes text: head / style / script dropped, entities decoded, whitespace collapsed', () => {
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', html: orderHtml() }) as GmailPart);
    expect(c.refs.body).toBe('html');
    expect(c.text).not.toMatch(/<(?!me>|person>|order>)[a-z]/i);
    expect(c.text).not.toContain('color:#123456');
    expect(c.text).not.toContain('Your order\n'); // <title> dropped
    expect(c.text).not.toContain('EventReservation');
    expect(c.text).toContain('Lumen Arcade & Halcy Drift');
    expect(c.text).toContain('Sat, Nov 7 · 8:00 PM');
    expect(c.text).not.toMatch(/[​‌]/);
    expect(c.text.split('\n').every((l) => l === l.trim() && l.length > 0)).toBe(true);
  });

  it('text/plain wins unless it is a stub or a template dump', () => {
    const long = `Your order is confirmed.\n${'Lumen Arcade at The Copper Hall. '.repeat(10)}`;
    expect(clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: long, html: '<p>HTML version</p>' }) as GmailPart).refs.body).toBe('plain');
    expect(clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: 'View this email in your browser.', html: '<p>HTML version with the order</p>' }) as GmailPart).text).toBe(
      'HTML version with the order',
    );
    const dump = `map[order:map[id:1 event:Lumen]] ${'x'.repeat(300)}`;
    expect(clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: dump, html: '<p>The real body</p>' }) as GmailPart).text).toBe('The real body');
    // No HTML at all: the plain text, however short.
    expect(clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: 'Tickets attached.' }) as GmailPart).text).toBe('Tickets attached.');
  });

  it('htmlToText keeps table cells apart and decodes numeric entities', () => {
    expect(htmlToText('<table><tr><td>A</td><td>B</td></tr><tr><td>&#67;&#x44;</td></tr></table>')).toBe('A B\nCD');
    expect(htmlToText('<p>one<br>two</p><!-- hidden --><script>var x=1</script>')).toBe('one\ntwo');
  });

  it('caps the excerpt at 3,500 chars from the top', () => {
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: Array.from({ length: 400 }, (_, i) => `Line ${i} of the order details`).join('\n') }) as GmailPart);
    expect(c.text.length).toBeLessThanOrEqual(3500);
    expect(c.text.startsWith('Line 0 of the order details')).toBe(true);
  });
});

describe('refs (local only)', () => {
  it('vendor event id (the order’s own event, not a recommendation), order ref, JSON-LD allowlist, partiful ids, seats', () => {
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', html: orderHtml({ seats: 2 }) }) as GmailPart);
    expect(c.refs).toMatchObject({
      vendorEventId: 'ticketmaster:0b00abcd12345678',
      orderRef: '12-34567/NY',
      partifulIds: ['AbCdEf123456'],
      qty: 2,
      qtySource: 'json_ld_seats',
      weekdays: { '11-07': 6 },
    });
    expect(c.refs.jsonLd).toEqual({
      name: 'Lumen Arcade: Night Signals Tour',
      startDate: '2026-11-07T20:00:00-05:00',
      endDate: null,
      venue: 'The Copper Hall',
      city: 'Springfield',
      performers: ['Lumen Arcade', 'Halcy Drift'],
    });
    const stored = JSON.stringify(c.refs.jsonLd);
    for (const never of ['Varga', 'ZXQ7Y81', 'TKT-55-01', '100 Main St', 'http', '12-34567']) expect(stored).not.toContain(never);
  });

  it('without numSeats the seat lines count (ranges and lists), and wallet passes before them', () => {
    expect(seatCount('Sec 101, Row F, Seats 7-8')).toBe(2);
    expect(seatCount('Section 3 Row 2 Seat 14\nSection 3 Row 2 Seat 15\nSection 3 Row 2 Seat 14')).toBe(2);
    expect(seatCount('Seats 7, 8, 9')).toBe(3);
    expect(seatCount('Choose your seats on the seat map')).toBe(0);
    const html = clean(payloadOf({ at: 0, from: 'x', subject: 'x', html: orderHtml() }) as GmailPart);
    expect(html.refs).toMatchObject({ qty: 2, qtySource: 'seat_lines' });
    const passes = clean(
      payloadOf({
        at: 0,
        from: 'x',
        subject: 'x',
        text: 'Your passes are attached. Seat 7',
        attachments: [
          { filename: 'ticket-1.pkpass', mimeType: 'application/vnd.apple.pkpass' },
          { filename: 'ticket-2.pkpass', mimeType: 'application/vnd.apple.pkpass' },
          { filename: 'invite.ics', mimeType: 'text/calendar' },
        ],
      }) as GmailPart,
    );
    expect(passes.refs).toMatchObject({ pkpass: 2, ics: true, qty: 2, qtySource: 'pkpass' });
  });

  it('order refs need a digit and are never a bare year', () => {
    expect(orderRefsIn('Order #: 12-34567/NY')).toEqual(['12-34567/NY']);
    expect(orderRefsIn('Confirmation number AB12CD')).toEqual(['AB12CD']);
    expect(orderRefsIn('Order Confirmation for Lumen Arcade')).toEqual([]);
    expect(orderRefsIn('Booking 2026')).toEqual([]);
  });

  it('a rejected word after the keyword never swallows the reference behind it ("Order Confirmation #…", "Booking reference …")', () => {
    expect(orderRefsIn('Order Confirmation #12345678')).toEqual(['12345678']);
    expect(orderRefsIn('Order Confirmation: 12-34567/NY')).toEqual(['12-34567/NY']);
    expect(orderRefsIn('Booking reference ABC123')).toEqual(['ABC123']);
    expect(orderRefsIn('Your Booking Reference: QX4K')).toEqual(['QX4K']);
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: `Booking reference ABC123\nLumen Arcade, Sat, Nov 7.\n${'Details below. '.repeat(20)}` }) as GmailPart);
    expect(c.refs.orderRef).toBe('ABC123');
    expect(c.text).toContain('Booking reference <order>');
    expect(c.text).not.toContain('ABC123');
  });

  it('weekday hints read "Sat, Nov 7", "Saturday 7 November" and "Sat 11/7"; conflicting ones are dropped', () => {
    expect(weekdayHints('Doors Sat, Nov 7 at 7')).toEqual({ '11-07': 6 });
    expect(weekdayHints('Saturday 9th January')).toEqual({ '01-09': 6 });
    expect(weekdayHints('Fri 1/8 and Sun. Dec 20')).toEqual({ '01-08': 5, '12-20': 0 });
    expect(weekdayHints('Sat, Nov 7 … Sun, Nov 7')).toEqual({});
  });

  it('JSON-LD dates that are not ISO dates never reach the structured data', () => {
    const ld = extractJsonLd(
      `<script type="application/ld+json">${JSON.stringify({ '@type': 'EventReservation', reservationFor: { '@type': 'Event', name: 'Halcy Drift', startDate: 'Saturday night with Kit Morrow', endDate: '2026-11-15' } })}</script>`,
    );
    expect(ld.event).toMatchObject({ name: 'Halcy Drift', startDate: null, endDate: '2026-11-15' });
  });

  it('malformed JSON-LD is ignored; a bare Event works without a reservation', () => {
    expect(extractJsonLd('<script type="application/ld+json">{not json</script>').event).toBeNull();
    const ld = extractJsonLd(`<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'MusicEvent', name: 'Halcy Drift', startDate: '2026-11-14T21:00' }] })}</script>`);
    expect(ld.event).toMatchObject({ name: 'Halcy Drift', startDate: '2026-11-14T21:00', performers: [] });
    expect(ld.reservations).toBe(0);
  });
});

describe('what the model may see', () => {
  it('no owner name, underName, ticket token, ticket number or order ref; labelled name lines masked', () => {
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', html: orderHtml() }) as GmailPart, { subject: 'Sam, your order 12-34567/NY is confirmed' });
    for (const never of ['Sam', 'Varga', 'ZXQ7Y81', 'TKT-55-01', '12-34567']) {
      expect(c.text, never).not.toContain(never);
      expect(c.subject, never).not.toContain(never);
    }
    expect(c.text).toContain('Hi <me>,');
    expect(c.text).toContain('Ticket holder: <person>');
    expect(c.text).toMatch(/Billing name\n<person>/);
    expect(c.text).toContain('Order # <order>');
    expect(c.subject).toBe('<me>, your order <order> is confirmed');
  });

  it('transfer counterparties: extracted with name, folded email key and quantity, then masked everywhere', () => {
    const text = `You sent 2 tickets to Dana Reyes (${DANA_EMAIL}).\nDana Reyes can accept them until Friday.\nDana will get an email from us.`;
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: `${text}\n${'Details below. '.repeat(20)}` }) as GmailPart, { subject: 'Your tickets are on their way to Dana Reyes' });
    expect(c.parties).toEqual([{ direction: 'sent_to', name: 'Dana Reyes', emailKey: DANA_EMAIL, quantity: 2 }]);
    for (const never of ['Dana', 'Reyes', DANA_EMAIL]) {
      expect(c.text).not.toContain(never);
      expect(c.subject).not.toContain(never);
    }
    expect(c.text).toContain('You sent 2 tickets to <person> (<person>).');
    expect(c.subject).toBe('Your tickets are on their way to <person>');
    // A name that ends a sentence: the full stop is not part of it, so the surname alone is masked elsewhere too.
    const end = clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: `You received tickets from Dana Reyes.\nReyes left a note for you.\n${'Details below. '.repeat(20)}` }) as GmailPart, {
      subject: 'Ticket transfer',
    });
    expect(end.parties).toEqual([{ direction: 'received_from', name: 'Dana Reyes', emailKey: null, quantity: null }]);
    expect(end.text).not.toContain('Reyes');
    expect(end.text).not.toContain('Dana');
  });

  it('a mail naming two people in one direction masks both; the stored party carries the direction’s total', () => {
    const kit = addr('kit.morrow', 'example.com');
    const text = `You sent 2 tickets to Dana Reyes (${DANA_EMAIL}) for Lumen Arcade, Sat, Nov 7.\nYou sent 1 ticket to Kit Morrow (${kit}) for Lumen Arcade, Sat, Nov 7.\nKit Morrow has 7 days to accept.`;
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: `${text}\n${'Details below. '.repeat(20)}` }) as GmailPart, { subject: 'Ticket transfer' });
    for (const never of ['Dana', 'Reyes', 'Kit', 'Morrow', DANA_EMAIL, kit]) expect(c.text, never).not.toContain(never);
    expect(c.text).toContain('You sent 1 ticket to <person> (<person>) for Lumen Arcade');
    expect(c.text).toContain('<person> has 7 days to accept.');
    expect(c.parties).toEqual([{ direction: 'sent_to', name: 'Dana Reyes', emailKey: DANA_EMAIL, quantity: 3 }]);
    // One person named twice (with and without the surname) is still one: no double count.
    const once = extractCounterparties('Your tickets are on their way to Dana', `You sent 2 tickets to Dana R. (${DANA_EMAIL}).`);
    expect(once).toEqual([{ direction: 'sent_to', name: 'Dana R.', emailKey: DANA_EMAIL, quantity: 2 }]);
    // A name in one sentence and only the address in another are one person too.
    const split = extractCounterparties('Your tickets are on their way to Dana Reyes', `You sent 2 tickets to ${DANA_EMAIL}.`);
    expect(split).toEqual([{ direction: 'sent_to', name: 'Dana Reyes', emailKey: DANA_EMAIL, quantity: 2 }]);
  });

  it('counterparty phrasings in both directions; the owner is never his own counterparty', () => {
    const p = (subject: string, text = '') => extractCounterparties(subject, text, { ownerNames: OWNER });
    expect(p('Dana Reyes sent you 2 tickets')).toEqual([{ direction: 'received_from', name: 'Dana Reyes', emailKey: null, quantity: 2 }]);
    expect(p('Great news! Dana Reyes Sent You Tickets')).toEqual([{ direction: 'received_from', name: 'Dana Reyes', emailKey: null, quantity: null }]);
    expect(p('Dana accepted your ticket transfer')).toEqual([{ direction: 'sent_to', name: 'Dana', emailKey: null, quantity: null }]);
    expect(p('Your tickets are on its way to Dana Reyes')).toEqual([{ direction: 'sent_to', name: 'Dana Reyes', emailKey: null, quantity: null }]);
    expect(p('Tickets from Sam Varga', 'Sam Varga transferred 2 tickets to Dana Reyes')).toEqual([{ direction: 'sent_to', name: 'Dana Reyes', emailKey: null, quantity: 2 }]);
    expect(p('Your tickets have been transferred')).toEqual([]);
    expect(p('Ticketmaster sent you tickets')).toEqual([]);
    // The generic phrasings need a mail about a transfer; the event's own names are never a counterparty.
    expect(p('Your tickets from The Copper Hall', 'Doors at 7.')).toEqual([]);
    expect(p('Your tickets were sent to Apple Wallet')).toEqual([]);
    expect(p('Ticket transfer', 'You received tickets from Dana Reyes.')).toEqual([{ direction: 'received_from', name: 'Dana Reyes', emailKey: null, quantity: null }]);
    expect(extractCounterparties('Ticket transfer', 'A transfer from The Copper Hall', { notNames: ['The Copper Hall'] })).toEqual([]);
    const fold = extractCounterparties('', `2 tickets to Dana Reyes (${addr('Dana.Reyes+tix', 'gmail.com')})`);
    expect(fold[0]!.emailKey).toBe(addr('danareyes', 'gmail.com'));
  });

  it('cuts at the first reply marker; a forwarded ticket keeps the forwarded mail, not the forwarder’s note', () => {
    expect(cutQuoted('Thanks, see you there!\nOn Tue, Oct 6, 2026 at 9:00 AM Rowan Quill wrote:\n> old order text', false)).toBe('Thanks, see you there!\n');
    expect(cutQuoted('Top\n-----Original Message-----\nquoted', false)).toBe('Top\n');
    const fwd = `Here you go Sam! Love, Rowan\n---------- Forwarded message ---------\nFrom: Tickets Example <${addr('noreply', 'tickets.example')}>\nDate: Mon, Oct 5, 2026 at 3:14 PM\nSubject: Your order\nTo: Rowan Quill <${addr('rowan.quill', 'example.com')}>\n\nYour order is confirmed.\nOrder #: AB-1234\nOn Sun, Oct 4 someone wrote:\n> older`;
    const cut = dropHeaderLines(cutQuoted(fwd, true));
    expect(cut).not.toContain('Here you go');
    expect(cut).not.toContain('Rowan');
    expect(cut).not.toContain('older');
    expect(cut).toContain('Your order is confirmed.');
    // Not forwarded: the note is all there is.
    expect(cutQuoted(fwd, false)).toBe('Here you go Sam! Love, Rowan\n');
  });

  it('Outlook: a "From: / Sent:" block cuts a reply; a forwarded ticket keeps only the forwarded mail', () => {
    expect(cutQuoted(`Thanks!\nFrom: Rowan Quill <${addr('rowan.quill', 'example.com')}>\nSent: Monday, October 5, 2026 3:14 PM\nTo: Sam\n> old order`, false)).toBe('Thanks!\n');
    const fw = `See you there - Rowan\n________________________________\nFrom: Tickets Example <${addr('noreply', 'tickets.example')}>\nSent: Monday, October 5, 2026 3:14 PM\nTo: Rowan Quill <${addr('rowan.quill', 'example.com')}>\nSubject: Your order\n\nYour order is confirmed.\nOrder #: AB-1234`;
    expect(cutQuoted(fw, true)).toBe('Your order is confirmed.\nOrder #: AB-1234');
    // A Gmail forward of an Outlook forward: the inner header block is dropped too, the body kept.
    const nested = `fyi\n---------- Forwarded message ---------\nFrom: Rowan Quill <${addr('rowan.quill', 'example.com')}>\nDate: Tue, Oct 6, 2026\nSubject: FW: Your order\nTo: Sam\n\nYour order is confirmed.`;
    expect(cutQuoted(nested, true)).toBe('Your order is confirmed.');
  });

  it('drops From / To / Cc lines always, Date / Sent / Subject only inside a header block', () => {
    const t = 'Date: Sat, Nov 7\nDoors at 7\nFrom: A\nSent: Monday\nTo: B\nSubject: x\nBody';
    expect(dropHeaderLines(t)).toBe('Date: Sat, Nov 7\nDoors at 7\nBody');
  });

  it('labelled name lines: same line, the next line, or mid-line after a specific label', () => {
    expect(maskLabelledNames('Attendee: Kit Morrow\nPurchaser - Kit Morrow\nShip to:\nKit Morrow\nEvent name: Lumen Arcade')).toBe(
      'Attendee: <person>\nPurchaser - <person>\nShip to:\n<person>\nEvent name: Lumen Arcade',
    );
    expect(maskLabelledNames('Order #: 77. Ticket Holder: Kit Morrow, Section 101. Event name: Lumen Arcade')).toBe(
      'Order #: 77. Ticket Holder: <person>, Section 101. Event name: Lumen Arcade',
    );
  });

  it('a subject that opens by addressing someone masks the name, never the event or a date', () => {
    expect(maskVocative('Rowan, your tickets are here')).toBe('<person>, your tickets are here');
    expect(maskVocative("Fwd: Rowan Quill, you're going to Lumen Arcade!")).toBe("Fwd: <person>, you're going to Lumen Arcade!");
    expect(maskVocative('<me>, your order confirmation')).toBe('<me>, your order confirmation');
    expect(maskVocative('Lumen Arcade at The Copper Hall')).toBe('Lumen Arcade at The Copper Hall');
    expect(maskVocative('Lumen Arcade, Halcy Drift and more')).toBe('Lumen Arcade, Halcy Drift and more');
    expect(maskVocative('Saturday, you’re going!')).toBe('Saturday, you’re going!');
    expect(maskVocative('Great news, your tickets are ready')).toBe('Great news, your tickets are ready');
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: `Your order is confirmed.\n${'Details. '.repeat(30)}` }) as GmailPart, {
      subject: 'Fwd: Rowan, here are your tickets',
      forwarded: true,
      vendor: null,
    });
    expect(c.subject).toBe('Fwd: <person>, here are your tickets');
  });

  it('greetings name whoever the mail was for: masked unless it is the owner (already <me>)', () => {
    expect(maskGreetings('Hi Rowan,\nThanks for your order.\nDear Kit Morrow: welcome')).toBe('Hi <person>,\nThanks for your order.\nDear <person>: welcome');
    expect(maskGreetings('Hi <me>, thank you for ordering.')).toBe('Hi <me>, thank you for ordering.');
  });

  it('a forwarded order from a friend: refs say forwarded, nothing of the forwarder reaches the text', () => {
    const fwd = `Sam - you're coming with us! Rowan\n---------- Forwarded message ---------\nFrom: Tickets Example <${addr('noreply', 'tickets.example')}>\nTo: Rowan Quill <${addr('rowan.quill', 'example.com')}>\n\nYour order is confirmed: 2 tickets to Lumen Arcade, Sat, Nov 7. Order #: AB-1234. Purchaser: Rowan Quill\n${'More info. '.repeat(30)}`;
    const c = clean(payloadOf({ at: 0, from: 'x', subject: 'x', text: fwd }) as GmailPart, { subject: 'Fwd: Your order confirmation', forwarded: true, vendor: null });
    expect(c.refs).toMatchObject({ forwarded: true, orderRef: 'AB-1234' });
    expect(c.text).not.toContain('Rowan');
    expect(c.text).not.toContain('Quill');
    expect(c.text).toContain('Your order is confirmed: 2 tickets to Lumen Arcade, Sat, Nov 7.');
  });
});
