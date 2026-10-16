/**
 * Synthetic WhatsApp for Mac snapshot: ChatStorage / ContactsV2 / LID .sqlite files built in a temp dir with the
 * store's Core Data schema (table and column names as the Mac app ships them; only the tables the adapter reads).
 * Synthetic data only: 555-01xx numbers, invented names, made-up LIDs and stanza ids.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { msToCoreData } from '../../../src/adapters/whatsapp/mapping';
import type { SnapshotFiles } from '../../../src/adapters/whatsapp/reader';
import { tempDir } from '../../helpers';

export const CHAT_SCHEMA = /* sql */ `
CREATE TABLE ZWACHATSESSION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZARCHIVED INTEGER, ZCONTACTABID INTEGER,
  ZFLAGS INTEGER, ZHIDDEN INTEGER, ZIDENTITYVERIFICATIONEPOCH INTEGER, ZIDENTITYVERIFICATIONSTATE INTEGER, ZMESSAGECOUNTER INTEGER,
  ZREMOVED INTEGER, ZSESSIONTYPE INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZUNREADCOUNT INTEGER, ZGROUPINFO INTEGER, ZLASTMESSAGE INTEGER,
  ZPROPERTIES INTEGER, ZLASTMESSAGEDATE TIMESTAMP, ZLOCATIONSHARINGENDDATE TIMESTAMP, ZCONTACTIDENTIFIER VARCHAR, ZCONTACTJID VARCHAR,
  ZETAG VARCHAR, ZLASTMESSAGETEXT VARCHAR, ZPARTNERNAME VARCHAR, ZSAVEDINPUT VARCHAR );
CREATE TABLE ZWAGROUPMEMBER ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACTABID INTEGER, ZISACTIVE INTEGER,
  ZISADMIN INTEGER, ZSENDERKEYSENT INTEGER, ZCHATSESSION INTEGER, ZRECENTGROUPCHAT INTEGER, ZCONTACTIDENTIFIER VARCHAR,
  ZCONTACTNAME VARCHAR, ZFIRSTNAME VARCHAR, ZMEMBERJID VARCHAR );
CREATE TABLE ZWAMESSAGE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHILDMESSAGESDELIVEREDCOUNT INTEGER,
  ZCHILDMESSAGESPLAYEDCOUNT INTEGER, ZCHILDMESSAGESREADCOUNT INTEGER, ZDATAITEMVERSION INTEGER, ZDOCID INTEGER, ZENCRETRYCOUNT INTEGER,
  ZFILTEREDRECIPIENTCOUNT INTEGER, ZFLAGS INTEGER, ZGROUPEVENTTYPE INTEGER, ZISFROMME INTEGER, ZMESSAGEERRORSTATUS INTEGER,
  ZMESSAGESTATUS INTEGER, ZMESSAGETYPE INTEGER, ZSORT INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZSTARRED INTEGER, ZCHATSESSION INTEGER,
  ZGROUPMEMBER INTEGER, ZLASTSESSION INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEINFO INTEGER, ZPARENTMESSAGE INTEGER, ZMESSAGEDATE TIMESTAMP,
  ZSENTDATE TIMESTAMP, ZFROMJID VARCHAR, ZMEDIASECTIONID VARCHAR, ZPHASH VARCHAR, ZPUSHNAME VARCHAR, ZSTANZAID VARCHAR, ZTEXT VARCHAR,
  ZTOJID VARCHAR );
CREATE TABLE ZWAPROFILEPUSHNAME ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR );
CREATE TABLE ZWAMESSAGEINFO ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMESSAGE INTEGER, ZRECEIPTINFO BLOB );
`;

export const CONTACTS_SCHEMA = /* sql */ `
CREATE TABLE ZWAADDRESSBOOKCONTACT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDISAPPEARINGMODEDURATION INTEGER,
  ZPHONESTATUS INTEGER, ZSECTIONSORT INTEGER, ZSORT INTEGER, ZSOURCE INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZSYNCPOLICY INTEGER,
  ZSYNCWITHSERVERSTATE INTEGER, ZABOUTEXPIRATIONTIMESTAMP TIMESTAMP, ZABOUTTIMESTAMP TIMESTAMP, ZDISAPPEARINGMODETIMESTAMP TIMESTAMP,
  ZLASTUPDATED TIMESTAMP, ZABOUTEMOJI VARCHAR, ZABOUTTEXT VARCHAR, ZBUSINESSNAME VARCHAR, ZFULLNAME VARCHAR, ZGIVENNAME VARCHAR,
  ZHIGHLIGHTEDNAME VARCHAR, ZIDENTIFIER VARCHAR, ZINTEROPJID VARCHAR, ZLASTNAME VARCHAR, ZLID VARCHAR, ZLIDHASH VARCHAR,
  ZLOCALIZEDPHONENUMBER VARCHAR, ZNOTES VARCHAR, ZPHONENUMBER VARCHAR, ZPHONENUMBERLABEL VARCHAR, ZPNHASH VARCHAR,
  ZSEARCHTOKENLIST VARCHAR, ZSECTIONTITLE VARCHAR, ZUNIQUEID VARCHAR, ZUSERNAME VARCHAR, ZWHATSAPPID VARCHAR, ZDEVICELIST BLOB );
`;

export const LID_SCHEMA = /* sql */ `
CREATE TABLE ZWAZACCOUNT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCURRENTPHONENUMBERSHARINGSTATE INTEGER,
  ZSTATE INTEGER, ZUSERTYPE INTEGER, ZUSERNAMESTATE INTEGER, ZCREATEDAT TIMESTAMP, ZCOUNTRYCODE VARCHAR, ZDISPLAYNAME VARCHAR,
  ZIDENTIFIER VARCHAR, ZPHONENUMBER VARCHAR, ZUSERNAME VARCHAR, ZADDITIONALDATA BLOB );
CREATE TABLE ZWAPHONENUMBERLIDPAIR ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTIMESTAMP TIMESTAMP, ZLID VARCHAR,
  ZPHONENUMBER VARCHAR );
`;

export const jid = (e164: string) => `${e164.replace(/^\+/, '')}@s.whatsapp.net`;
export const lid = (digits: string) => `${digits}@lid`;
/** A group JID (built at runtime so no address-shaped literal sits in the repo). */
export const gus = (id: string) => `${id}@g.us`;
/** A phone JID from a raw user part (digits, optionally with a :device suffix). */
export const pn = (user: string) => `${user}@s.whatsapp.net`;

export interface MessageSpec {
  session: number;
  /** 'me', a ZWAGROUPMEMBER Z_PK (group posts), or omitted (the 1:1 counterpart). */
  from?: 'me' | number;
  at: number;
  text?: string | null;
  type?: number;
  groupEvent?: number;
  stanza?: string | null;
}

let stanzaCounter = 0;
export const nextStanza = () => `SYN${String(++stanzaCounter).padStart(8, '0')}`;

export class WaFixture {
  readonly dir: string;
  readonly chatPath: string;
  readonly contactsPath: string;
  readonly lidPath: string;
  chat: Database.Database;
  contacts: Database.Database | null;
  lidDb: Database.Database | null;
  private readonly cleanup: () => void;

  constructor(o: { contacts?: boolean; lid?: boolean; chatSchema?: string; contactsSchema?: string; lidSchema?: string } = {}) {
    const t = tempDir('yb-wa-');
    this.dir = t.dir;
    this.cleanup = t.cleanup;
    this.chatPath = path.join(t.dir, 'ChatStorage.sqlite');
    this.contactsPath = path.join(t.dir, 'ContactsV2.sqlite');
    this.lidPath = path.join(t.dir, 'LID.sqlite');
    this.chat = new Database(this.chatPath);
    this.chat.exec(o.chatSchema ?? CHAT_SCHEMA);
    this.contacts = o.contacts === false ? null : new Database(this.contactsPath);
    this.contacts?.exec(o.contactsSchema ?? CONTACTS_SCHEMA);
    this.lidDb = o.lid === false ? null : new Database(this.lidPath);
    this.lidDb?.exec(o.lidSchema ?? LID_SCHEMA);
  }

  files(): SnapshotFiles {
    return { chat: this.chatPath, contacts: this.contacts ? this.contactsPath : null, lid: this.lidDb ? this.lidPath : null };
  }

  addSession(chatJid: string, type: number, name: string | null = null): number {
    return Number(
      this.chat.prepare('INSERT INTO ZWACHATSESSION (ZCONTACTJID, ZSESSIONTYPE, ZPARTNERNAME, ZREMOVED, ZHIDDEN) VALUES (?, ?, ?, 0, 0)').run(chatJid, type, name)
        .lastInsertRowid,
    );
  }

  /** ZCONTACTNAME is always '' and ZFIRSTNAME holds base64 protobuf in real stores; both are filled that way. */
  addMember(session: number, memberJid: string, o: { active?: boolean; admin?: boolean } = {}): number {
    return Number(
      this.chat
        .prepare(`INSERT INTO ZWAGROUPMEMBER (ZCHATSESSION, ZMEMBERJID, ZISACTIVE, ZISADMIN, ZCONTACTNAME, ZFIRSTNAME) VALUES (?, ?, ?, ?, '', ?)`)
        .run(session, memberJid, o.active === false ? 0 : 1, o.admin ? 1 : 0, 'CgZTeW50aBIGUHJvdG9idWZCbG9iWFla')
        .lastInsertRowid,
    );
  }

  addMessage(m: MessageSpec): { pk: number; stanza: string | null } {
    const stanza = m.stanza === undefined ? nextStanza() : m.stanza;
    const fromMe = m.from === 'me' ? 1 : 0;
    const pk = Number(
      this.chat
        .prepare(
          `INSERT INTO ZWAMESSAGE (ZCHATSESSION, ZGROUPMEMBER, ZISFROMME, ZMESSAGETYPE, ZGROUPEVENTTYPE, ZMESSAGEDATE, ZSENTDATE, ZSTANZAID, ZTEXT,
             ZPUSHNAME) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.session,
          typeof m.from === 'number' ? m.from : null,
          fromMe,
          m.type ?? 0,
          m.groupEvent ?? 0,
          msToCoreData(m.at),
          msToCoreData(m.at),
          stanza,
          m.text === undefined ? 'synthetic text' : m.text,
          'CgZTeW50aBIGUHJvdG9idWZCbG9iWFla',
        ).lastInsertRowid,
    );
    return { pk, stanza };
  }

  addPushName(forJid: string, name: string): void {
    this.chat.prepare('INSERT INTO ZWAPROFILEPUSHNAME (ZJID, ZPUSHNAME) VALUES (?, ?)').run(forJid, name);
  }

  addContact(c: { name: string; jid?: string | null; lid?: string | null; localPhone?: string | null }): void {
    this.contacts!.prepare('INSERT INTO ZWAADDRESSBOOKCONTACT (ZFULLNAME, ZWHATSAPPID, ZLID, ZPHONENUMBER) VALUES (?, ?, ?, ?)').run(
      c.name,
      c.jid ?? null,
      c.lid ?? null,
      c.localPhone ?? null,
    );
  }

  /** LID.ZWAZACCOUNT: ZIDENTIFIER is the LID, ZPHONENUMBER the number; ZDISPLAYNAME is a masked number. */
  addLidAccount(lidValue: string, phone: string): void {
    this.lidDb!.prepare(`INSERT INTO ZWAZACCOUNT (ZIDENTIFIER, ZPHONENUMBER, ZDISPLAYNAME) VALUES (?, ?, '+1 ••• ••• ••01')`).run(lidValue, phone);
  }

  addLidPair(lidValue: string, phone: string): void {
    this.lidDb!.prepare('INSERT INTO ZWAPHONENUMBERLIDPAIR (ZLID, ZPHONENUMBER) VALUES (?, ?)').run(lidValue, phone);
  }

  /** A re-linked device: an empty store whose Z_PKs start over at 1. */
  wipeMessages(): void {
    this.chat.exec('DELETE FROM ZWAMESSAGE');
  }

  close(): void {
    for (const db of [this.chat, this.contacts, this.lidDb]) if (db?.open) db.close();
    this.cleanup();
  }
}

export function writeEmptyStore(dir: string): string {
  const p = path.join(dir, 'ChatStorage.sqlite');
  const db = new Database(p);
  db.exec('CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB)');
  db.close();
  fs.chmodSync(p, 0o600);
  return p;
}
