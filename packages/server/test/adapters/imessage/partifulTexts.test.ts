import { describe, expect, it } from 'vitest';
import { parsePartifulText } from '../../../src/adapters/imessage/partifulTexts';

// Synthetic texts in Partiful's template shapes (invented names, titles and venues).
describe('parsePartifulText', () => {
  it('invites: inviter, title, link id', () => {
    expect(
      parsePartifulText('🎉 Hey Sam, Riley Park invited you to Rooftop Pizza Party!\nReply X to stop invites from this host\nhttps://partiful.com/e/Q1w2E3r4?ac=true'),
    ).toEqual({
      kind: 'invite',
      eventId: 'Q1w2E3r4',
      shortCode: null,
      updateId: null,
      title: 'Rooftop Pizza Party',
      inviterName: 'Riley Park',
      guestName: null,
      rsvp: 'invited',
      venue: null,
    });
  });

  it('RSVP confirmations and waitlists', () => {
    expect(parsePartifulText("🤘 You're now on the list for Board Game Night!")).toMatchObject({ kind: 'rsvp', title: 'Board Game Night', rsvp: 'going' });
    expect(parsePartifulText('You’re on the waitlist for Supper Club!')).toMatchObject({ kind: 'rsvp', title: 'Supper Club', rsvp: 'waitlist' });
  });

  it('reminders with and without a venue', () => {
    expect(parsePartifulText('⏰ Board Game Night is in 2 hours, at The Meeple Room, 400 Elm St!')).toMatchObject({
      kind: 'reminder',
      title: 'Board Game Night',
      venue: 'The Meeple Room',
    });
    expect(parsePartifulText("⏰ Hey Sam, 1 week until Supper Club! It's next Friday at 7pm. Can you make it?")).toMatchObject({
      kind: 'reminder',
      title: 'Supper Club',
      venue: null,
    });
  });

  it('text blasts keep the title and link ids, never the body', () => {
    const s = parsePartifulText('📣 The host of Supper Club sent a Text Blast: door code is 4411 https://partiful.com/e/Zx9Yw8?update=Up77');
    expect(s).toMatchObject({ kind: 'blast', title: 'Supper Club', eventId: 'Zx9Yw8', updateId: 'Up77' });
    expect(JSON.stringify(s)).not.toContain('door code');
    expect(parsePartifulText('📣 The host of Supper Club sent a Text Blast: see you soon go.partiful.com/aB3dE')).toMatchObject({
      kind: 'blast',
      shortCode: 'aB3dE',
      eventId: null,
    });
  });

  it('host-side RSVPs, bare links and unknown shapes', () => {
    expect(parsePartifulText('Congrats Sam, you got your first RSVP! Jordan Lee responded "Going" to Supper Club')).toMatchObject({
      kind: 'host_rsvp',
      guestName: 'Jordan Lee',
      rsvp: 'going',
      title: 'Supper Club',
    });
    expect(parsePartifulText('https://partiful.com/e/Q1w2E3r4?c=1&rsvped=true')).toMatchObject({ kind: 'link', eventId: 'Q1w2E3r4', rsvp: 'going' });
    expect(parsePartifulText('Your Partiful login code is 123456')).toMatchObject({ kind: 'other', eventId: null });
    expect(parsePartifulText('   ')).toBeNull();
    expect(parsePartifulText(null)).toBeNull();
  });
});
