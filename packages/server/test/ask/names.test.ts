/**
 * Ask answers over iMessage name people unambiguously: "Sam R." unless that reads as the owner's own short name or
 * as another person's in the same answer; then the full last name, applied locally only (the model sees "Sam R."
 * and tokens). Every name here is invented.
 */
import { describe, expect, it } from 'vitest';
import { askNetwork } from '../../src/ask';
import { answerNames, createScope, visiblePerson, type PersonRow } from '../../src/ask/retrieval';
import type { AgentServices } from '../../src/services';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { seedIdentity, seedPerson } from '../helpers';
import { buildAskWorld, NOW } from './world';

/** The owner as the resolver leaves them: a "Me" row, named by their Contacts card identity. */
function ownerNamed(w: ReturnType<typeof buildAskWorld>, name: string): void {
  w.db.prepare(`UPDATE people SET display_name = 'Me', first_name = NULL, last_name = NULL WHERE id = ?`).run(w.me);
  seedIdentity(w.db, w.me, 'addressbook_id', 'AB-OWNER-1', { display_name: name });
}

function setup() {
  const w = buildAskWorld();
  const reyes = seedPerson(w.db, { first_name: 'Sam', last_name: 'Reyes', display_name: 'Sam Reyes' });
  const egress = new FakeEgress();
  const tok = { sam: egress.tokenFor(w.sam), jess: egress.tokenFor(w.jess), reyes: egress.tokenFor(reyes) };
  const llm = new FakeLlmClient();
  const services: AgentServices = { llm, egress, outbound: new FakeOutboundSender(), push: new FakePushSender() };
  const ask = (question: string, channel: 'web' | 'imessage' = 'imessage') => askNetwork({ db: w.db, question, channel, services: () => services, now: NOW });
  return { w, reyes, tok, llm, ask };
}

describe('answerNames', () => {
  const rows = (w: ReturnType<typeof buildAskWorld>, ...ids: string[]): PersonRow[] => {
    const scope = createScope(w.db, { now: NOW, forModel: false });
    return ids.map((id) => visiblePerson(scope, id)!);
  };

  it('keeps "First L." when nothing collides (the owner here is "Owner S.")', () => {
    const w = buildAskWorld();
    const [sam, jess] = rows(w, w.sam, w.jess);
    const named = answerNames(w.db, [sam!, jess!]);
    expect([named.of(sam!), named.of(jess!)]).toEqual(['Sam R.', 'Jess K.']);
    expect(named.colliding.size).toBe(0);
  });

  it('the owner’s own short name, and a shared one within the answer, switch to the full last name', () => {
    const w = buildAskWorld();
    ownerNamed(w, 'Jess Keller');
    const reyes = seedPerson(w.db, { first_name: 'Sam', last_name: 'Reyes', display_name: 'Sam Reyes' });
    const [sam, jess, samReyes] = rows(w, w.sam, w.jess, reyes);
    const named = answerNames(w.db, [sam!, jess!, samReyes!]);
    expect([named.of(sam!), named.of(jess!), named.of(samReyes!)]).toEqual(['Sam Rivera', 'Jess Kim', 'Sam Reyes']);
    // Sam Reyes alone collides with nobody.
    expect(answerNames(w.db, [samReyes!]).of(samReyes!)).toBe('Sam R.');
  });
});

describe('Ask over iMessage', () => {
  it('the default is unchanged: "First L."', async () => {
    const t = setup();
    t.llm.on('ask', { text: `${t.tok.sam} lives in Austin and ${t.tok.jess} works at Acme.` });
    const out = await t.ask('Who do I know in Austin?');
    expect(out.answer).toBe('Sam R. lives in Austin and Jess K. works at Acme.');
  });

  it('a person whose "First L." is the owner’s own is named in full; the model never sees the last name', async () => {
    const t = setup();
    ownerNamed(t.w, 'Jess Keller');
    t.llm.on('ask', { text: `${t.tok.jess} works at Acme; ${t.tok.sam} lives in Austin.` });
    const out = await t.ask('Where does Jess work?');
    expect(out.answer).toBe('Jess Kim works at Acme; Sam R. lives in Austin.');
    expect(t.llm.calls).toHaveLength(1);
    expect(t.llm.calls[0]!.userText).toContain('Jess K.');
    expect(t.llm.calls[0]!.userText).not.toContain('Kim');
  });

  it('two people with the same "First L." in one answer are both named in full; alone, "First L." again', async () => {
    const t = setup();
    t.llm.on('ask', { text: `${t.tok.sam} and ${t.tok.reyes} both climb.` }, { text: `${t.tok.reyes} climbs.` });
    expect((await t.ask('Who climbs?')).answer).toBe('Sam Rivera and Sam Reyes both climb.');
    expect((await t.ask('Who else climbs?')).answer).toBe('Sam R. climbs.');
  });

  it('a people list (one line per person) names a same-short pair in full on every line', async () => {
    const t = setup();
    t.llm.on('ask', { text: `- ${t.tok.sam} — climbs on Saturdays\n- ${t.tok.reyes} — climbs with ${t.tok.sam}\n- ${t.tok.jess} — belays` });
    const out = await t.ask('Who climbs?');
    expect(out.list?.rows.map((r) => r.detail)).toEqual(['climbs on Saturdays', 'climbs with Sam Rivera', 'belays']);
    expect(out.answer).toMatch(/^- Sam Rivera — climbs on Saturdays/m);
    expect(out.answer).toMatch(/^- Sam Reyes — climbs with Sam Rivera/m);
    expect(out.answer).toMatch(/^- Jess K\. — belays/m);
  });

  it('the web keeps full display names; the plain-search fallback over iMessage follows the same rule', async () => {
    const t = setup();
    ownerNamed(t.w, 'Jess Keller');
    t.llm.on('ask', { text: `${t.tok.sam} and ${t.tok.reyes} both climb.` }, { unavailable: 'api_error' });
    expect((await t.ask('Who climbs?', 'web')).answer).toBe('Sam Rivera and Sam Reyes both climb.');
    const degraded = await t.ask('who do I know in Austin');
    expect(degraded.degraded).toBe(true);
    expect(degraded.answer).toMatch(/^- Jess Kim — East Austin/m);
    expect(degraded.answer).toMatch(/^- Sam R\. — Austin/m);
  });
});
