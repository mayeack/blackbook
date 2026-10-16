/**
 * Read-only access to one collector snapshot: the ChatStorage copy opened read-only (query_only on top), with the
 * ContactsV2 and LID copies ATTACHed (a read-only connection attaches read-only too). Every query here uses only
 * columns listed in schemaGuard.ts; call check() first. Rows hold message text and names: they stay in memory,
 * nothing here logs.
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { checkSchema, type SchemaCheck } from './schemaGuard';
import { SESSION_DIRECT, SESSION_GROUP } from './mapping';

export interface SnapshotFiles {
  chat: string;
  contacts: string | null;
  lid: string | null;
}

export interface SessionRow {
  pk: number;
  jid: string;
  type: number;
  name: string | null;
}

export interface RosterRow {
  sessionPk: number;
  jid: string;
  active: number;
  admin: number;
}

export interface NameRow {
  jid: string;
  name: string;
}

export interface ContactRow {
  name: string | null;
  jid: string | null;
  lid: string | null;
}

export interface LidRow {
  lid: string;
  phone: string;
}

/** One aggregate bucket of new messages (for the §1.4 signals): no text, only counts and the time range. */
export interface ActivityRow {
  sessionPk: number;
  memberJid: string | null;
  fromMe: number;
  type: number | null;
  groupEvent: number | null;
  hasText: number;
  n: number;
  first: number | null;
  last: number | null;
}

export interface MessageRow {
  pk: number;
  stanza: string | null;
  fromMe: number;
  type: number | null;
  groupEvent: number | null;
  date: number | null;
  text: string | null;
  sessionPk: number;
  memberJid: string | null;
}

export class SnapshotReaderError extends Error {
  constructor(readonly reason: 'bad_path' | 'open_failed', message: string) {
    super(message);
    this.name = 'SnapshotReaderError';
  }
}

const INCLUDED = `s.ZSESSIONTYPE IN (${SESSION_DIRECT}, ${SESSION_GROUP})`;

export class SnapshotReader {
  private checked: SchemaCheck | null = null;

  private constructor(
    readonly db: Database.Database,
    readonly attached: { contacts: boolean; lid: boolean },
  ) {}

  /** Opens the copies the collector made (absolute paths to .sqlite files). */
  static open(files: SnapshotFiles): SnapshotReader {
    const usable = (p: string | null): p is string => p !== null && path.isAbsolute(p) && p.endsWith('.sqlite');
    if (!usable(files.chat)) throw new SnapshotReaderError('bad_path', 'snapshot chat store path is not an absolute .sqlite path');
    let db: Database.Database;
    try {
      db = new Database(files.chat, { readonly: true, fileMustExist: true });
    } catch (e) {
      throw new SnapshotReaderError('open_failed', `could not open the snapshot chat store (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    const attached = { contacts: false, lid: false };
    try {
      db.pragma('query_only = ON');
      for (const [name, file] of [
        ['contacts', files.contacts],
        ['lid', files.lid],
      ] as const) {
        if (!usable(file)) continue;
        db.prepare(`ATTACH DATABASE ? AS ${name}`).run(file);
        attached[name] = true;
      }
    } catch (e) {
      db.close();
      throw new SnapshotReaderError('open_failed', `could not attach a snapshot store (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    return new SnapshotReader(db, attached);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  check(): SchemaCheck {
    this.checked = checkSchema(this.db, this.attached);
    return this.checked;
  }

  /** Every query runs only after a passing check(). */
  private ensureChecked(): SchemaCheck {
    if (!this.checked?.ok) throw new Error('whatsapp snapshot: schema not checked (or broken); call check() first');
    return this.checked;
  }

  maxPk(): number {
    this.ensureChecked();
    return (this.db.prepare('SELECT max(Z_PK) FROM ZWAMESSAGE').pluck().get() as number | null) ?? 0;
  }

  /** The '{chat_jid}:{stanza}' of the row at a Z_PK (null if gone), to tell a re-linked store from the old one. */
  rowKeyAt(pk: number): string | null {
    this.ensureChecked();
    const r = this.db
      .prepare('SELECT s.ZCONTACTJID AS jid, m.ZSTANZAID AS stanza FROM ZWAMESSAGE m LEFT JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION WHERE m.Z_PK = ?')
      .get(pk) as { jid: string | null; stanza: string | null } | undefined;
    return r ? `${r.jid ?? ''}:${r.stanza ?? ''}` : null;
  }

  sessions(): SessionRow[] {
    this.ensureChecked();
    return this.db
      .prepare(
        `SELECT s.Z_PK AS pk, trim(s.ZCONTACTJID) AS jid, s.ZSESSIONTYPE AS type, NULLIF(trim(s.ZPARTNERNAME), '') AS name
         FROM ZWACHATSESSION s WHERE ${INCLUDED} AND NULLIF(trim(s.ZCONTACTJID), '') IS NOT NULL ORDER BY s.Z_PK`,
      )
      .all() as SessionRow[];
  }

  roster(): RosterRow[] {
    this.ensureChecked();
    return this.db
      .prepare(
        `SELECT gm.ZCHATSESSION AS sessionPk, trim(gm.ZMEMBERJID) AS jid, coalesce(gm.ZISACTIVE, 1) AS active, coalesce(gm.ZISADMIN, 0) AS admin
         FROM ZWAGROUPMEMBER gm JOIN ZWACHATSESSION s ON s.Z_PK = gm.ZCHATSESSION
         WHERE s.ZSESSIONTYPE = ${SESSION_GROUP} AND NULLIF(trim(gm.ZMEMBERJID), '') IS NOT NULL ORDER BY gm.Z_PK`,
      )
      .all() as RosterRow[];
  }

  pushNames(): NameRow[] {
    this.ensureChecked();
    return this.db
      .prepare(
        `SELECT trim(ZJID) AS jid, trim(ZPUSHNAME) AS name FROM ZWAPROFILEPUSHNAME
         WHERE NULLIF(trim(ZJID), '') IS NOT NULL AND NULLIF(trim(ZPUSHNAME), '') IS NOT NULL`,
      )
      .all() as NameRow[];
  }

  contacts(): ContactRow[] {
    this.ensureChecked();
    if (!this.attached.contacts) return [];
    return this.db
      .prepare(
        `SELECT NULLIF(trim(ZFULLNAME), '') AS name, NULLIF(trim(ZWHATSAPPID), '') AS jid, NULLIF(trim(ZLID), '') AS lid
         FROM contacts.ZWAADDRESSBOOKCONTACT
         WHERE NULLIF(trim(ZWHATSAPPID), '') IS NOT NULL OR NULLIF(trim(ZLID), '') IS NOT NULL`,
      )
      .all() as ContactRow[];
  }

  /** LID → phone from LID.ZWAZACCOUNT (ZDISPLAYNAME is a masked number: never read). */
  lidAccounts(): LidRow[] {
    this.ensureChecked();
    if (!this.attached.lid) return [];
    return this.db
      .prepare(
        `SELECT trim(ZIDENTIFIER) AS lid, trim(ZPHONENUMBER) AS phone FROM lid.ZWAZACCOUNT
         WHERE NULLIF(trim(ZIDENTIFIER), '') IS NOT NULL AND NULLIF(trim(ZPHONENUMBER), '') IS NOT NULL ORDER BY Z_PK`,
      )
      .all() as LidRow[];
  }

  /** LID → phone from LID.ZWAPHONENUMBERLIDPAIR, when that table exists. */
  lidPairs(): LidRow[] {
    if (!this.ensureChecked().optional.lidPairs) return [];
    return this.db
      .prepare(
        `SELECT trim(ZLID) AS lid, trim(ZPHONENUMBER) AS phone FROM lid.ZWAPHONENUMBERLIDPAIR
         WHERE NULLIF(trim(ZLID), '') IS NOT NULL AND NULLIF(trim(ZPHONENUMBER), '') IS NOT NULL ORDER BY Z_PK`,
      )
      .all() as LidRow[];
  }

  /** Counts of the messages in (after, max] by session, sender, direction and type. */
  activity(after: number, max: number): ActivityRow[] {
    this.ensureChecked();
    return this.db
      .prepare(
        `SELECT m.ZCHATSESSION AS sessionPk, trim(gm.ZMEMBERJID) AS memberJid, coalesce(m.ZISFROMME, 0) AS fromMe, m.ZMESSAGETYPE AS type,
           m.ZGROUPEVENTTYPE AS groupEvent, (NULLIF(trim(m.ZTEXT), '') IS NOT NULL) AS hasText, count(*) AS n,
           min(m.ZMESSAGEDATE) AS first, max(m.ZMESSAGEDATE) AS last
         FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
         WHERE m.Z_PK > @after AND m.Z_PK <= @max AND ${INCLUDED}
         GROUP BY 1, 2, 3, 4, 5, 6`,
      )
      .all({ after, max }) as ActivityRow[];
  }

  /** One page of messages in (after, max], Z_PK order; `sinceDate` (Core Data seconds) keeps only recent rows. */
  messages(after: number, max: number, limit: number, sinceDate: number | null = null): MessageRow[] {
    this.ensureChecked();
    return this.db
      .prepare(
        `SELECT m.Z_PK AS pk, m.ZSTANZAID AS stanza, coalesce(m.ZISFROMME, 0) AS fromMe, m.ZMESSAGETYPE AS type, m.ZGROUPEVENTTYPE AS groupEvent,
           m.ZMESSAGEDATE AS date, m.ZTEXT AS text, m.ZCHATSESSION AS sessionPk, trim(gm.ZMEMBERJID) AS memberJid
         FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
         WHERE m.Z_PK > @after AND m.Z_PK <= @max AND ${INCLUDED} AND (@since IS NULL OR m.ZMESSAGEDATE >= @since)
         ORDER BY m.Z_PK LIMIT @limit`,
      )
      .all({ after, max, limit, since: sinceDate }) as MessageRow[];
  }
}
