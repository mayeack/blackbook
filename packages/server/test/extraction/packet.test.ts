/** Window rendering: line format, reactions, replies, attachments, links, CONTEXT, cards and exclusions. */
import { describe, expect, it } from 'vitest';
import { collect, submitSteady } from '../../src/extraction/run';
import { DAY, HOUR, MIN, NOW, buildXWorld, deps, fakes, packetOf, windowsOf } from './world';

describe('rendered windows', () => {
  it('renders reactions, replies, attachments and link domains; excluded people never appear', async () => {
    const w = buildXWorld();
    w.db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('llm.excluded_person_ids', ?, 0, 0)`).run(JSON.stringify([w.jordan]));
    const outside = w.msg(w.group, w.ids.priya, NOW - 9 * DAY, 'old planning thread about the gym');
    // 15 newer lines push it out of CONTEXT.
    for (let i = 0; i < 15; i++) w.msg(w.group, w.ids.priya, NOW - 8 * DAY + i * MIN, `filler line number ${i} about nothing much`);
    const a = w.msg(w.group, w.ids.priya, NOW - 2 * HOUR, 'who wants to try the new climbing gym on saturday morning?');
    w.msg(w.group, w.ids.jordan, NOW - 2 * HOUR + MIN, 'I am in, my email is jordan@example.com if you need it');
    w.msg(w.group, null, NOW - 2 * HOUR + 2 * MIN, 'count me in for saturday morning', { reply_to_msg_id: a });
    w.msg(w.group, w.ids.priya, NOW - 2 * HOUR + 3 * MIN, 'replying to the old thread here', { reply_to_msg_id: outside });
    w.msg(w.group, w.ids.priya, NOW - 2 * HOUR + 4 * MIN, 'here is the route map https://www.example.org/routes?id=12', {
      kind: 'attachment',
      attachments: JSON.stringify([{ mime: 'image/jpeg', name: 'map.jpg' }]),
    });
    w.db
      .prepare(`INSERT INTO message_reactions (source_reaction_id, message_id, actor_identity_id, is_from_me, type, at) VALUES ('r1', ?, NULL, 1, 'love', ?)`)
      .run(a, NOW - HOUR);
    const f = fakes();
    await submitSteady(deps(w, f));
    const text = f.llm.calls[0]!.userText;
    const nl = text.split('\n');
    const at = (s: string) => nl.find((l) => l.includes(s))!;
    expect(at('who wants to try')).toMatch(/^\[m:\d+\|2026-10-16 01:30\|P\w+\] who wants to try the new climbing gym on saturday morning\? \{❤ ME\}$/);
    expect(at('count me in')).toMatch(/^\[m:\d+\|[^\]]+\|ME\] ↩m:\d+ count me in/);
    expect(at('old thread here')).toMatch(/\] ↩earlier replying/);
    expect(at('route map')).toMatch(/here is the route map <link:example\.org> <image>$/);
    // Jordan is excluded: none of his text, no card, no token.
    expect(text).not.toMatch(/I am in|example\.com|Jordan/);
    const [win] = windowsOf(w.db, w.group);
    const pk = packetOf(w.db, win!.id);
    expect(Object.values(pk.refs).map((r) => r.personId)).not.toContain(w.jordan);
    // ...but his message is covered, so it is never offered again.
    expect(w.db.prepare('SELECT count(*) FROM extraction_coverage WHERE window_id = ?').pluck().get(win!.id)).toBe(5);
  });

  it('cards list ≤6 non-sensitive facts with F refs; CONTEXT shows earlier lines; the summary rolls forward', async () => {
    const w = buildXWorld();
    const ins = w.db.prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, sensitive, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0.9, 'confirmed', 0, 'test', 0, 0)`,
    );
    ins.run('f1', w.sam, 'interest', 'climbing', 'climbing', 0);
    ins.run('f2', w.sam, 'location_current', 'Denver', 'denver', 0);
    ins.run('f3', w.sam, 'other', 'sees a therapist', 'sees a therapist', 1);
    w.msg(w.dm, w.ids.sam, NOW - 2 * DAY + HOUR, 'we covered the plan for the ski trip yesterday already');
    const f = fakes();
    await submitSteady(deps(w, f));
    await collect(deps(w, f, NOW + 10 * MIN));
    w.db.prepare(`UPDATE conversations SET summary = 'P1 and ME are planning a ski trip.' WHERE id = ?`).run(w.dm);
    w.msg(w.dm, w.ids.sam, NOW + DAY - HOUR, 'ok booked the cabin for the ski trip, splitting it four ways');
    await submitSteady(deps(w, f, NOW + DAY));
    const text = f.llm.calls.filter((c) => c.method === 'batch').at(-1)!.userText;
    expect(text).toMatch(/\nSUMMARY:\nP1 and ME are planning a ski trip\.\n/);
    expect(text).toMatch(/\nP1 Sam · facts: F1 \w+: \w+; F2 \w+: \w+\n/);
    expect(text).not.toContain('therapist');
    expect(text).toMatch(/\nCONTEXT:\n\[m:1\|[^\]]+\] we covered the plan[^\n]*\nNEW:\n\[m:2\|/);
  });
});
