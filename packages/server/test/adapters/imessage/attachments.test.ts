/** Which screenshots a self-thread command carries, and fetching them from the collector. Synthetic rows only. */
import { afterEach, describe, expect, it } from 'vitest';
import { collectorAttachmentSource, commandImageRefs, imageAttachments } from '../../../src/adapters/imessage/attachments';
import type { DB } from '../../../src/db/connection';
import { memDb } from '../../helpers';
import { BASE, FakeCollector, T0 } from './fakeCollector';

const PNG = { mime: 'image/png', uti: 'public.png', name: 'Screenshot 1.png', bytes: 1_955_133, is_sticker: false };
const STICKER = { mime: 'image/png', uti: 'public.png', name: 'sticker.png', bytes: 999, is_sticker: true };
const PDF = { mime: 'application/pdf', uti: 'com.adobe.pdf', name: 'menu.pdf', bytes: 5000, is_sticker: false };

function world() {
  const db = memDb();
  const conv = (id: string, kind: string) =>
    db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, 'imessage', ?, ?, ?, ?)`).run(id, `c-${id}`, kind, T0, T0);
  conv('self', 'self');
  conv('dm', 'direct');
  let seq = 0;
  const row = (o: { at: number; text?: string | null; att?: object[]; kind?: string; bot?: boolean; conv?: string; fromMe?: boolean; guid?: string }): number =>
    Number(
      db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, attachments, is_bot, ingested_at, updated_at)
           VALUES ('imessage', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          o.guid ?? `GUID-${++seq}`,
          o.conv ?? 'self',
          o.fromMe === false ? 0 : 1,
          o.at,
          o.kind ?? (o.text === null ? 'attachment' : 'text'),
          o.text === undefined ? 'yb this person' : o.text,
          o.att ? JSON.stringify(o.att) : null,
          o.bot ? 1 : 0,
          o.at,
          o.at,
        ).lastInsertRowid,
    );
  return { db, row };
}

const guids = (db: DB, refs: { messageGuid: string; index: number }[]) => refs.map((r) => `${r.messageGuid}#${r.index}`);

describe('command screenshots', () => {
  it('a text sent with a screenshot carries its own images (not stickers, not documents)', () => {
    const { db, row } = world();
    const id = row({ at: T0, att: [STICKER, PDF, PNG], guid: 'CMD' });
    expect(guids(db, commandImageRefs(db, id))).toEqual(['CMD#2']);
    expect(imageAttachments(JSON.stringify([{ uti: 'public.heic', name: 'IMG_1.HEIC', bytes: 10 }]))).toEqual([{ index: 0, key: 'IMG_1.HEIC|10' }]);
    expect(imageAttachments('not json')).toEqual([]);
  });

  it('else the attachment-only rows he sent in the 3 minutes before, newest first, each file once, at most 2', () => {
    const { db, row } = world();
    row({ at: T0 - 5 * 60_000, text: null, att: [{ ...PNG, name: 'too old.png' }], guid: 'OLD' });
    row({ at: T0 - 120_000, text: null, att: [{ ...PNG, name: 'a.png' }], guid: 'A' });
    row({ at: T0 - 90_000, text: null, att: [{ ...PNG, name: 'b.png' }], guid: 'B-SEND' });
    row({ at: T0 - 90_000, text: null, att: [{ ...PNG, name: 'b.png' }], guid: 'B-ECHO' }); // the note-to-self echo
    row({ at: T0 - 60_000, text: null, att: [{ ...PNG, name: 'c.png' }], guid: 'BOT', bot: true });
    row({ at: T0 - 30_000, text: null, att: [{ ...PNG, name: 'd.png' }], guid: 'DM', conv: 'dm' });
    const id = row({ at: T0, guid: 'CMD' });
    expect(guids(db, commandImageRefs(db, id))).toEqual(['B-ECHO#0', 'A#0']);
    expect(commandImageRefs(db, 999_999)).toEqual([]);
  });

  it('a plain text with nothing around it carries none', () => {
    const { db, row } = world();
    expect(commandImageRefs(db, row({ at: T0 }))).toEqual([]);
  });
});

describe('collector attachment source', () => {
  const fakes: FakeCollector[] = [];
  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.close();
  });

  it('answers the downscaled JPEG, or null (with only the error code logged) when the collector refuses', async () => {
    const f = new FakeCollector().writeToken();
    fakes.push(f);
    const data = Buffer.from('synthetic jpeg bytes').toString('base64');
    f.attachmentImages.set('CMD#0', { width: 723, height: 1568, data_base64: data });
    const logged: unknown[] = [];
    const log = { warn: (event: string, fields: unknown) => logged.push({ event, fields }) } as never;
    const source = collectorAttachmentSource({ url: BASE, tokenFile: f.tokenFile, log, client: f.client() });
    expect(source.configured).toBe(true);
    expect(await source.image({ messageGuid: 'CMD', index: 0 })).toEqual({ mediaType: 'image/jpeg', data, width: 723, height: 1568 });
    expect(f.calls.at(-1)).toBe('/v1/imessage/attachment?message_guid=CMD&index=0&max_edge=1568');
    expect(await source.image({ messageGuid: 'DM-PHOTO', index: 0 })).toBeNull();
    expect(logged).toEqual([{ event: 'commands.image_unavailable', fields: { error_class: 'attachment_not_allowed' } }]);
  });
});
