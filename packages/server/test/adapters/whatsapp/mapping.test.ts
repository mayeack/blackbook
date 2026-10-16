import { describe, expect, it } from 'vitest';
import {
  chatKind,
  cleanWaName,
  coreDataToMs,
  internationalDigits,
  lidDigits,
  messageKind,
  messageText,
  msToCoreData,
  nameAt,
  parseUserJid,
  sourceMsgId,
} from '../../../src/adapters/whatsapp/mapping';
import { gus, pn } from './fixture';

describe('whatsapp mapping', () => {
  it('Core Data seconds (since 2001) ↔ Unix ms', () => {
    expect(coreDataToMs(0)).toBe(Date.UTC(2001, 0, 1));
    expect(coreDataToMs(812_808_000.25)).toBe(Date.UTC(2026, 9, 4, 12) + 250);
    expect(coreDataToMs(msToCoreData(Date.UTC(2026, 9, 14, 12)))).toBe(Date.UTC(2026, 9, 14, 12));
    expect(coreDataToMs(null)).toBeNull();
    expect(coreDataToMs(Number.NaN)).toBeNull();
  });

  it('JIDs: phone and LID users (device/agent suffixes dropped); groups and broadcasts are not people', () => {
    expect(parseUserJid(pn('15125550101'))).toEqual({ kind: 'phone', digits: '15125550101' });
    expect(parseUserJid(pn('15125550101:12'))).toEqual({ kind: 'phone', digits: '15125550101' });
    expect(parseUserJid('100000000000002@lid')).toEqual({ kind: 'lid', digits: '100000000000002' });
    expect(parseUserJid(gus('120363000000000001'))).toBeNull();
    expect(parseUserJid('status@broadcast')).toBeNull();
    expect(parseUserJid('15125550101')).toBeNull();
    expect(lidDigits('100000000000002')).toBe('100000000000002');
    expect(lidDigits('100000000000002@lid')).toBe('100000000000002');
    expect(lidDigits(pn('15125550101'))).toBeNull();
    expect(internationalDigits('+15125550101')).toBe('15125550101');
    expect(internationalDigits(pn('15125550101'))).toBe('15125550101');
    expect(internationalDigits('555-01')).toBeNull();
  });

  it('chat sessions: 0 direct, 1 group; broadcast lists, status, channels and odd JIDs stay out', () => {
    expect(chatKind(0, pn('15125550101'))).toBe('direct');
    expect(chatKind(0, '100000000000002@lid')).toBe('direct');
    expect(chatKind(1, gus('120363000000000001'))).toBe('group');
    expect(chatKind(2, '1700000000@broadcast')).toBeNull();
    expect(chatKind(3, 'status@broadcast')).toBeNull();
    expect(chatKind(0, 'status@broadcast')).toBeNull();
    expect(chatKind(0, '120363000000000009@newsletter')).toBeNull();
    expect(chatKind(1, pn('15125550101'))).toBeNull();
    expect(chatKind(0, null)).toBeNull();
  });

  it('message types → kinds', () => {
    expect(messageKind(0, 0, true)).toMatchObject({ kind: 'text', known: true });
    expect(messageKind(1, 0, false)).toMatchObject({ kind: 'attachment', attachment: 'image' });
    expect(messageKind(3, null, false)).toMatchObject({ kind: 'attachment', attachment: 'audio' });
    expect(messageKind(5, 0, false)).toMatchObject({ kind: 'attachment', attachment: 'location' });
    expect(messageKind(8, 0, true)).toMatchObject({ kind: 'attachment', attachment: 'document' });
    expect(messageKind(7, 0, true).kind).toBe('link');
    expect(messageKind(15, 0, false).kind).toBe('sticker');
    expect(messageKind(6, 0, true).kind).toBe('system');
    // Any group-event row is system, whatever its type code.
    expect(messageKind(15, 3, false).kind).toBe('system');
    expect(messageKind(0, 1, true).kind).toBe('system');
    // 14: deleted (no text) vs a poll question.
    expect(messageKind(14, 0, false)).toMatchObject({ kind: 'text', retracted: true });
    expect(messageKind(14, 0, true).kind).toBe('poll');
    // Unknown codes never invent activity without text.
    expect(messageKind(99, 0, false)).toMatchObject({ kind: 'system', known: false });
    expect(messageKind(99, 0, true)).toMatchObject({ kind: 'text', known: false });
    expect(messageText('text', '  https://example.com/x  ')).toEqual({ kind: 'link', text: 'https://example.com/x' });
    expect(messageText('system', 'Group renamed')).toEqual({ kind: 'system', text: null });
  });

  it('source ids: chat_jid:stanza, else a stable hash of what survives a re-link', () => {
    const row = { sentAt: 1, type: 6, fromMe: false, memberJid: null, text: null };
    expect(sourceMsgId(pn('15125550101'), 'SYN00000001', row)).toBe(`${pn('15125550101')}:SYN00000001`);
    const g = gus('120363000000000001');
    const a = sourceMsgId(g, null, row);
    expect(a.startsWith(`${g}:~`)).toBe(true);
    expect(a.slice(g.length + 2)).toMatch(/^[\w-]{20}$/);
    expect(sourceMsgId(g, '  ', row)).toBe(a);
    expect(sourceMsgId(g, null, { ...row, sentAt: 2 })).not.toBe(a);
  });

  it('names: NULLIF blanks, never phone numbers, JIDs or base64 protobuf blobs', () => {
    expect(cleanWaName('  Alex   Rivera ')).toBe('Alex Rivera');
    expect(cleanWaName('')).toBeNull();
    expect(cleanWaName('‪+1 (512) 555-0101‬')).toBeNull();
    expect(cleanWaName(pn('15125550101'))).toBeNull();
    expect(cleanWaName('CgZTeW50aBIGUHJvdG9idWZCbG9iWFla')).toBeNull();
    expect(cleanWaName('Casey 🧗')).toBe('Casey 🧗');
    expect(nameAt(1000, 'contact')).toBeGreaterThan(nameAt(1000, 'partner'));
    expect(nameAt(1000, 'partner')).toBeGreaterThan(nameAt(1000, 'push'));
  });
});
