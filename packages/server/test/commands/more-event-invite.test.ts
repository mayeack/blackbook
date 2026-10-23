/**
 * "more" and event_invite (commands/executor.ts more → delivery/selection.ts selectedItemById as of now): the next
 * suggestion it texts goes through the same check as the brief (intel/eventInvites.ts eventInviteStale), so it never
 * names a show whose tickets are gone, nor someone who has joined the show since. Every name, performer, venue and id
 * is invented.
 */
import { describe, expect, it } from 'vitest';
import { metAt, ticketEvent, ticketOccasion, ticketParty } from '../intel/eventInviteWorld';
import { BRIEF_AT, commandsWorld, DAY, MIN } from './world';

const at = (mins: number) => BRIEF_AT + mins * MIN;

function moreWorld() {
  const w = commandsWorld();
  const sam = w.person('Sam', 'Rivera');
  const priya = w.person('Priya', 'Shah');
  const jordan = w.person('Jordan', 'Lee');
  w.digest([{ personId: sam }, { personId: priya, kind: 'reply_debt' }, { personId: jordan, kind: 'commitment_due' }]);
  const tom = w.person('Tom', 'Tansy');
  const uma = w.person('Uma', 'Umber');
  const ticket = ticketEvent(w.db, { title: 'Velvet Static', start: BRIEF_AT + 6 * DAY, performers: ['Velvet Static'], venue: 'Lantern Hall', venueKey: 'lantern hall' });
  const occ = ticketOccasion(w.db, ticket, { title: 'Velvet Static', start: BRIEF_AT + 6 * DAY, venue: 'Lantern Hall' });
  const past = ticketEvent(w.db, { title: 'Velvet Static spring tour', start: BRIEF_AT - 40 * DAY, performers: ['Velvet Static'], status: 'gave_away' });
  const m1 = ticketOccasion(w.db, past, { title: 'Velvet Static spring tour', start: BRIEF_AT - 40 * DAY });
  const links = [metAt(w.db, tom, { occasionId: m1 }), metAt(w.db, uma, { occasionId: m1 })];
  // Stored by the nightly stage, not ranked into the brief: the best one "more" can offer.
  const invite = w.suggestion({ personId: tom, kind: 'event_invite', score: 0.9 });
  const payload = { startsAt: BRIEF_AT + 6 * DAY, daysOut: 6, metRefs: [`o:${m1}`, `o:${m1}`], metLinkIds: links, sims: [1, 1], confs: [0.8, 0.8], screenshot: [0, 0] };
  w.db.prepare('UPDATE suggestions SET occasion_id = ?, person_ids = ?, signals = ?, expires_at = ? WHERE id = ?').run(occ, JSON.stringify([tom, uma]), JSON.stringify(payload), BRIEF_AT + 6 * DAY, invite);
  const fallback = w.suggestion({ personId: w.person('Emery', 'Vale'), kind: 'dormant', score: 0.4 });
  return { w, ticket, invite, fallback };
}

describe('"more" and an "Invite to a show" suggestion', () => {
  it('texts it while the tickets are held', async () => {
    const { w } = moreWorld();
    w.say('more', at(1));
    await w.run({ now: at(2) });
    expect(w.outbound.sent.at(-1)!.text).toMatch(/^\u{1F168} 4\. Invite Tom T\. and Uma U\. to Velvet Static\?/u);
  });

  it('passes over it once the tickets are sold', async () => {
    const { w, ticket } = moreWorld();
    w.db.prepare(`UPDATE ticket_events SET status = 'sold' WHERE id = ?`).run(ticket);
    w.say('more', at(1));
    await w.run({ now: at(2) });
    const text = w.outbound.sent.at(-1)!.text;
    expect(text).toMatch(/^\u{1F168} 4\. Reconnect with Emery V\.\?/u);
    expect(text).not.toMatch(/Velvet|Tom|Uma/);
  });

  it('leaves out someone who has a ticket from the owner by now', async () => {
    const { w, ticket } = moreWorld();
    ticketParty(w.db, ticket, { name: 'Tom Tansy' });
    w.say('more', at(1));
    await w.run({ now: at(2) });
    const text = w.outbound.sent.at(-1)!.text;
    expect(text).toMatch(/^\u{1F168} 4\. Invite Uma U\. to Velvet Static\?/u);
    expect(text).not.toMatch(/Tom/);
  });
});
