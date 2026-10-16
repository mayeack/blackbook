/**
 * Synthetic Core-Data-like legacy store for tests: the real table/column names and Core Data conventions
 * (Z_PRIMARYKEY entity numbers, Z_<ent><REL> join tables, 16-byte ZID blobs, seconds-since-2001 timestamps,
 * bplist-encoded string arrays) with invented people, 555-01xx numbers and example.com emails only.
 */
import Database from 'better-sqlite3';
import { UID } from 'bplist-parser';

// ---- minimal bplist00 writer: strings, integers, arrays, dicts, UIDs ------------------------------------------
type PlistValue = string | number | PlistValue[] | { [k: string]: PlistValue } | UID;

export function encodeBplist(root: PlistValue): Buffer {
  const objects: Buffer[] = [];
  const intBytes = (n: number, width: number) => {
    const b = Buffer.alloc(width);
    b.writeUIntBE(n, 0, width);
    return b;
  };
  const lengthMarker = (type: number, len: number) =>
    len < 15 ? Buffer.from([(type << 4) | len]) : Buffer.concat([Buffer.from([(type << 4) | 0xf, 0x11]), intBytes(len, 2)]);
  const add = (v: PlistValue): number => {
    const index = objects.length;
    objects.push(Buffer.alloc(0));
    let body: Buffer;
    if (v instanceof UID) body = Buffer.from([0x81, ...intBytes(v.UID, 2)]);
    else if (typeof v === 'number') body = Buffer.from([0x13, ...intBytes(0, 4), ...intBytes(v, 4)]);
    else if (typeof v === 'string') {
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(v)) body = Buffer.concat([lengthMarker(0x5, v.length), Buffer.from(v, 'ascii')]);
      else {
        const utf16 = Buffer.from(v, 'utf16le').swap16();
        body = Buffer.concat([lengthMarker(0x6, utf16.length / 2), utf16]);
      }
    } else if (Array.isArray(v)) {
      const refs = v.map(add);
      body = Buffer.concat([lengthMarker(0xa, refs.length), ...refs.map((r) => intBytes(r, 2))]);
    } else {
      const keys = Object.keys(v);
      const keyRefs = keys.map(add);
      const valRefs = keys.map((k) => add(v[k]!));
      body = Buffer.concat([lengthMarker(0xd, keys.length), ...keyRefs.map((r) => intBytes(r, 2)), ...valRefs.map((r) => intBytes(r, 2))]);
    }
    objects[index] = body;
    return index;
  };
  add(root);
  const header = Buffer.from('bplist00', 'latin1');
  const offsets: number[] = [];
  let pos = header.length;
  for (const o of objects) {
    offsets.push(pos);
    pos += o.length;
  }
  const offsetTable = Buffer.concat(offsets.map((o) => intBytes(o, 4)));
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(4, 6); // offset int size
  trailer.writeUInt8(2, 7); // object ref size
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(pos), 24);
  return Buffer.concat([header, ...objects, offsetTable, trailer]);
}

/** What SwiftData writes for [String]: an NSKeyedArchiver whose root is an NSArray of strings. */
export function keyedStringArray(values: string[]): Buffer {
  const classIndex = values.length + 2;
  return encodeBplist({
    $version: 100000,
    $archiver: 'NSKeyedArchiver',
    $top: { root: new UID(1) },
    $objects: [
      '$null',
      { 'NS.objects': values.map((_, i) => new UID(i + 2)), $class: new UID(classIndex) },
      ...values,
      { $classname: 'NSArray', $classes: ['NSArray', 'NSObject'] },
    ],
  });
}

export const plainStringArray = (values: string[]) => encodeBplist(values);

/** A keyed archive whose root is a dictionary (not a string array): the import must refuse it. */
export const keyedDictionary = () =>
  encodeBplist({
    $version: 100000,
    $archiver: 'NSKeyedArchiver',
    $top: { root: new UID(1) },
    $objects: ['$null', { 'NS.keys': [new UID(2)], 'NS.objects': [new UID(3)], $class: new UID(4) }, 'k', 'v', { $classname: 'NSDictionary', $classes: ['NSDictionary', 'NSObject'] }],
  });

// ---- Core Data conventions ------------------------------------------------------------------------------------
export const APPLE_EPOCH_S = 978_307_200;
/** Unix ms → Core Data seconds since 2001. */
export const cd = (ms: number) => ms / 1000 - APPLE_EPOCH_S;

const ENTITY_TAG: Record<string, string> = {
  Contact: 'c0',
  Tag: 'a1',
  Group: 'b2',
  Location: 'd3',
  Note: 'e4',
  Activity: 'f5',
  Reminder: 'a6',
  ContactRelationship: 'b7',
  AppNotification: 'c8',
  Interaction: 'd9',
};

/** Deterministic legacy UUID for (entity, pk). */
export function legacyUuid(entity: string, pk: number): string {
  const tag = ENTITY_TAG[entity] ?? 'ff';
  return `${tag}000000-0000-4000-8000-${String(pk).padStart(12, '0')}`;
}
const zid = (entity: string, pk: number) => Buffer.from(legacyUuid(entity, pk).replace(/-/g, ''), 'hex');

export interface FxContact {
  pk: number;
  first?: string;
  last?: string;
  company?: string;
  jobTitle?: string;
  phones?: string[];
  emails?: string[];
  addresses?: string[];
  interests?: string[];
  mergedAway?: boolean;
  mergedInto?: number;
  hidden?: boolean;
  priority?: boolean;
  /** Core Data seconds */
  birthday?: number;
  family?: string;
  instagram?: string;
  twitter?: string;
  linkedin?: string;
  cn?: string;
  custom?: Record<string, string>;
  metVia?: number;
  encoding?: 'keyed' | 'plain';
  /** override one array column with a raw blob (shape-failure tests) */
  rawPhones?: Buffer;
  createdAt?: number;
}

export interface Fixture {
  /** entity name → Z_ENT (defaults to a shifted layout so discovery is exercised) */
  entities?: Record<string, number>;
  contacts: FxContact[];
  tags?: { pk: number; name: string; color?: string }[];
  groups?: { pk: number; name: string; color?: string; icon?: string }[];
  locations?: { pk: number; name: string; color?: string; icon?: string }[];
  tagLinks?: [number, number][];
  groupLinks?: [number, number][];
  locationLinks?: [number, number][];
  notes?: { pk: number; contact?: number; content: string; category?: string; createdAt?: number }[];
  activities?: { pk: number; name: string; date: number; endDate?: number; googleEventId?: string }[];
  /** [activityPk, contactPk] */
  activityContacts?: [number, number][];
  /** [activityPk, groupPk] */
  activityGroups?: [number, number][];
  reminders?: { pk: number; contact?: number; title: string; due?: number; completed?: boolean }[];
  relationships?: { pk: number; from: number; to: number; label: string; strength?: number }[];
  notifications?: { pk: number; contact?: number; dismissed?: boolean; kind?: string; createdAt?: number }[];
  interactions?: { pk: number; contact: number; type?: string; date: number; direction?: 'Sent' | 'Received'; summary?: string; duration?: number }[];
}

/** The real store's layout (Contact = 3, Group = 5, Location = 7, Tag = 11). */
export const REAL_ENTITIES: Record<string, number> = {
  Activity: 1,
  AppNotification: 2,
  Contact: 3,
  ContactRelationship: 4,
  Group: 5,
  Interaction: 6,
  Location: 7,
  Note: 8,
  RejectedCalendarEvent: 9,
  Reminder: 10,
  Tag: 11,
};

/** A different numbering (as after a model change): Contact = 4, Group = 6, Location = 8, Tag = 12. */
export const SHIFTED_ENTITIES: Record<string, number> = {
  Activity: 1,
  AppNotification: 2,
  Note: 3,
  Contact: 4,
  ContactRelationship: 5,
  Group: 6,
  Interaction: 7,
  Location: 8,
  RejectedCalendarEvent: 9,
  Reminder: 10,
  Tag: 12,
};

const DEVICE_COLS = 'ZCREATEDBYDEVICEID VARCHAR, ZCREATEDBYDEVICENAME VARCHAR, ZCREATEDBYPLATFORM VARCHAR, ZLASTEDITEDBYDEVICEID VARCHAR, ZLASTEDITEDBYDEVICENAME VARCHAR, ZLASTEDITEDBYPLATFORM VARCHAR';

/** Writes the fixture as a WAL-mode sqlite file (like the live store) and returns its path. */
export function buildLegacyStore(file: string, fx: Fixture): string {
  openLegacyFixture(file, fx).close();
  return file;
}

/**
 * Builds the fixture and leaves the connection open with auto-checkpoints off, like the running legacy server:
 * every committed page is still in the -wal, so a snapshot that skipped the WAL would see an empty store.
 */
export function openLegacyFixture(file: string, fx: Fixture): Database.Database {
  const E = fx.entities ?? SHIFTED_ENTITIES;
  const c = E.Contact!;
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(`
    CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
    CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);
    CREATE TABLE ZCONTACT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZISHIDDEN INTEGER, ZISMERGEDAWAY INTEGER, ZISPRIORITY INTEGER,
      ZSYNCVERSION INTEGER, ZMERGEDINTOCONTACT INTEGER, ZMETVIA INTEGER, ZBIRTHDAY TIMESTAMP, ZCREATEDAT TIMESTAMP, ZLASTINTERACTIONDATE TIMESTAMP,
      ZLASTSYNCEDAT TIMESTAMP, ZRELATIONSHIPSCORE FLOAT, ZUPDATEDAT TIMESTAMP, ZCNCONTACTIDENTIFIER VARCHAR, ZCOMPANY VARCHAR, ZFAMILYDETAILS VARCHAR,
      ZFIRSTNAME VARCHAR, ZINSTAGRAMHANDLE VARCHAR, ZJOBTITLE VARCHAR, ZLASTNAME VARCHAR, ZLINKEDINURL VARCHAR, ZPHOTOS3KEY VARCHAR,
      ZSCORETRENDRAW VARCHAR, ZSYNCSTATUS VARCHAR, ZTWITTERHANDLE VARCHAR, ZID BLOB, ZADDRESSES BLOB, ZEMAILS BLOB, ZINTERESTS BLOB, ZPHONES BLOB,
      ZCUSTOMFIELDS BLOB, ZPHOTODATA BLOB, ${DEVICE_COLS});
    CREATE TABLE ZTAG ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZLASTSYNCEDAT TIMESTAMP, ZUPDATEDAT TIMESTAMP, ZCOLORHEX VARCHAR, ZNAME VARCHAR, ZSYNCSTATUS VARCHAR, ZID BLOB);
    CREATE TABLE ZGROUP ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZLASTSYNCEDAT TIMESTAMP, ZUPDATEDAT TIMESTAMP, ZCOLORHEX VARCHAR, ZICON VARCHAR, ZNAME VARCHAR, ZSYNCSTATUS VARCHAR, ZID BLOB);
    CREATE TABLE ZLOCATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZLASTSYNCEDAT TIMESTAMP, ZUPDATEDAT TIMESTAMP, ZCOLORHEX VARCHAR, ZICON VARCHAR, ZNAME VARCHAR, ZSYNCSTATUS VARCHAR, ZID BLOB);
    CREATE TABLE ZNOTE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACT INTEGER, ZCREATEDAT TIMESTAMP, ZLASTSYNCEDAT TIMESTAMP, ZUPDATEDAT TIMESTAMP, ZCATEGORY VARCHAR, ZCONTENT VARCHAR, ZSYNCSTATUS VARCHAR, ZID BLOB);
    CREATE TABLE ZACTIVITY ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCREATEDAT TIMESTAMP, ZDATE TIMESTAMP, ZENDDATE TIMESTAMP, ZLASTSYNCEDAT TIMESTAMP, ZUPDATEDAT TIMESTAMP, ZACTIVITYDESCRIPTION VARCHAR, ZCOLORHEX VARCHAR, ZGOOGLEEVENTID VARCHAR, ZICON VARCHAR, ZNAME VARCHAR, ZSYNCSTATUS VARCHAR, ZID BLOB);
    CREATE TABLE ZREMINDER ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZISAUTOGENERATED INTEGER, ZISCOMPLETED INTEGER, ZCONTACT INTEGER, ZCREATEDAT TIMESTAMP, ZDUEDATE TIMESTAMP, ZLASTSYNCEDAT TIMESTAMP, ZUPDATEDAT TIMESTAMP, ZRECURRENCE VARCHAR, ZSYNCSTATUS VARCHAR, ZTITLE VARCHAR, ZID BLOB);
    CREATE TABLE ZCONTACTRELATIONSHIP ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFROMCONTACT INTEGER, ZTOCONTACT INTEGER, ZLASTSYNCEDAT TIMESTAMP, ZSTRENGTH FLOAT, ZUPDATEDAT TIMESTAMP, ZLABEL VARCHAR, ZSYNCSTATUS VARCHAR, ZID BLOB);
    CREATE TABLE ZAPPNOTIFICATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZISDISMISSED INTEGER, ZISREAD INTEGER, ZCREATEDAT TIMESTAMP, ZLASTSYNCEDAT TIMESTAMP, ZUPDATEDAT TIMESTAMP, ZKINDRAW VARCHAR, ZMESSAGE VARCHAR, ZSYNCSTATUS VARCHAR, ZTITLE VARCHAR, ZCONTACTID BLOB, ZID BLOB);
    CREATE TABLE ZINTERACTION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACT INTEGER, ZCREATEDAT TIMESTAMP, ZDATE TIMESTAMP, ZDURATION FLOAT, ZLASTSYNCEDAT TIMESTAMP, ZUPDATEDAT TIMESTAMP, ZDIRECTIONRAW VARCHAR, ZSENTIMENT VARCHAR, ZSUMMARY VARCHAR, ZSYNCSTATUS VARCHAR, ZTYPE VARCHAR, ZID BLOB);
    CREATE TABLE Z_${c}TAGS ( Z_${c}CONTACTS1 INTEGER, Z_${E.Tag}TAGS INTEGER, PRIMARY KEY (Z_${c}CONTACTS1, Z_${E.Tag}TAGS) );
    CREATE TABLE Z_${c}GROUPS ( Z_${c}CONTACTS3 INTEGER, Z_${E.Group}GROUPS1 INTEGER, PRIMARY KEY (Z_${c}CONTACTS3, Z_${E.Group}GROUPS1) );
    CREATE TABLE Z_${c}LOCATIONS ( Z_${c}CONTACTS2 INTEGER, Z_${E.Location}LOCATIONS INTEGER, PRIMARY KEY (Z_${c}CONTACTS2, Z_${E.Location}LOCATIONS) );
    CREATE TABLE Z_${E.Activity}CONTACTS ( Z_${E.Activity}ACTIVITIES INTEGER, Z_${c}CONTACTS INTEGER, PRIMARY KEY (Z_${E.Activity}ACTIVITIES, Z_${c}CONTACTS) );
    CREATE TABLE Z_${E.Activity}GROUPS ( Z_${E.Activity}ACTIVITIES1 INTEGER, Z_${E.Group}GROUPS INTEGER, PRIMARY KEY (Z_${E.Activity}ACTIVITIES1, Z_${E.Group}GROUPS) );
  `);
  const pk = db.prepare('INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)');
  for (const [name, ent] of Object.entries(E)) pk.run(ent, name);
  const created = cd(Date.UTC(2024, 0, 1));

  const insC = db.prepare(`INSERT INTO ZCONTACT (Z_PK, Z_ENT, Z_OPT, ZISHIDDEN, ZISMERGEDAWAY, ZISPRIORITY, ZSYNCVERSION, ZMERGEDINTOCONTACT, ZMETVIA,
    ZBIRTHDAY, ZCREATEDAT, ZUPDATEDAT, ZRELATIONSHIPSCORE, ZCNCONTACTIDENTIFIER, ZCOMPANY, ZFAMILYDETAILS, ZFIRSTNAME, ZINSTAGRAMHANDLE, ZJOBTITLE,
    ZLASTNAME, ZLINKEDINURL, ZSCORETRENDRAW, ZSYNCSTATUS, ZTWITTERHANDLE, ZID, ZADDRESSES, ZEMAILS, ZINTERESTS, ZPHONES, ZCUSTOMFIELDS)
    VALUES (@pk, ${c}, 1, @hidden, @merged, @priority, 0, @mergedInto, @metVia, @birthday, @created, @created, 42.5, @cn, @company, @family,
    @first, @instagram, @job, @last, @linkedin, 'stable', 'synced', @twitter, @zid, @addresses, @emails, @interests, @phones, @custom)`);
  for (const x of fx.contacts) {
    const arr = x.encoding === 'plain' ? plainStringArray : keyedStringArray;
    insC.run({
      pk: x.pk,
      hidden: x.hidden ? 1 : 0,
      merged: x.mergedAway ? 1 : 0,
      priority: x.priority ? 1 : 0,
      mergedInto: x.mergedInto ?? null,
      metVia: x.metVia ?? null,
      birthday: x.birthday ?? null,
      created: x.createdAt ?? created + x.pk,
      cn: x.cn ?? null,
      company: x.company ?? null,
      family: x.family ?? null,
      first: x.first ?? '',
      instagram: x.instagram ?? null,
      job: x.jobTitle ?? null,
      last: x.last ?? '',
      linkedin: x.linkedin ?? null,
      twitter: x.twitter ?? null,
      zid: zid('Contact', x.pk),
      addresses: arr(x.addresses ?? []),
      emails: arr(x.emails ?? []),
      interests: arr(x.interests ?? []),
      phones: x.rawPhones ?? arr(x.phones ?? []),
      custom: Buffer.from(JSON.stringify(x.custom ?? {}), 'utf8'),
    });
  }
  const coll = (table: string, entity: string, rows: { pk: number; name: string; color?: string; icon?: string }[] = []) => {
    const hasIcon = table !== 'ZTAG';
    const ins = db.prepare(
      `INSERT INTO ${table} (Z_PK, Z_ENT, Z_OPT, ZCOLORHEX, ZNAME, ZSYNCSTATUS, ZID${hasIcon ? ', ZICON' : ''}) VALUES (?, ?, 1, ?, ?, 'synced', ?${hasIcon ? ', ?' : ''})`,
    );
    for (const r of rows) {
      const args: unknown[] = [r.pk, E[entity], r.color ?? '3498DB', r.name, zid(entity, r.pk)];
      if (hasIcon) args.push(r.icon ?? 'folder');
      ins.run(...args);
    }
  };
  coll('ZTAG', 'Tag', fx.tags);
  coll('ZGROUP', 'Group', fx.groups);
  coll('ZLOCATION', 'Location', fx.locations);
  const link = (table: string, rows: [number, number][] = []) => {
    const ins = db.prepare(`INSERT INTO ${table} VALUES (?, ?)`);
    for (const [a, b] of rows) ins.run(a, b);
  };
  link(`Z_${c}TAGS`, fx.tagLinks);
  link(`Z_${c}GROUPS`, fx.groupLinks);
  link(`Z_${c}LOCATIONS`, fx.locationLinks);
  link(`Z_${E.Activity}CONTACTS`, fx.activityContacts);
  link(`Z_${E.Activity}GROUPS`, fx.activityGroups);

  const insN = db.prepare(`INSERT INTO ZNOTE (Z_PK, Z_ENT, Z_OPT, ZCONTACT, ZCREATEDAT, ZUPDATEDAT, ZCATEGORY, ZCONTENT, ZID) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`);
  for (const n of fx.notes ?? []) {
    const at = n.createdAt ?? created + 100;
    insN.run(n.pk, E.Note, n.contact ?? null, at, at, n.category ?? 'General', n.content, zid('Note', n.pk));
  }
  const insA = db.prepare(
    `INSERT INTO ZACTIVITY (Z_PK, Z_ENT, Z_OPT, ZCREATEDAT, ZDATE, ZENDDATE, ZACTIVITYDESCRIPTION, ZCOLORHEX, ZGOOGLEEVENTID, ZICON, ZNAME, ZID)
     VALUES (?, ?, 1, ?, ?, ?, 'synthetic activity', 'E67E22', ?, 'star', ?, ?)`,
  );
  for (const a of fx.activities ?? []) insA.run(a.pk, E.Activity, created, a.date, a.endDate ?? null, a.googleEventId ?? null, a.name, zid('Activity', a.pk));
  const insR = db.prepare(
    `INSERT INTO ZREMINDER (Z_PK, Z_ENT, Z_OPT, ZISAUTOGENERATED, ZISCOMPLETED, ZCONTACT, ZCREATEDAT, ZDUEDATE, ZTITLE, ZID) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of fx.reminders ?? []) insR.run(r.pk, E.Reminder, r.completed ? 1 : 0, r.contact ?? null, created, r.due ?? null, r.title, zid('Reminder', r.pk));
  const insRel = db.prepare(
    `INSERT INTO ZCONTACTRELATIONSHIP (Z_PK, Z_ENT, Z_OPT, ZFROMCONTACT, ZTOCONTACT, ZSTRENGTH, ZLABEL, ZID) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  for (const r of fx.relationships ?? []) insRel.run(r.pk, E.ContactRelationship, r.from, r.to, r.strength ?? 0.5, r.label, zid('ContactRelationship', r.pk));
  const insAN = db.prepare(
    `INSERT INTO ZAPPNOTIFICATION (Z_PK, Z_ENT, Z_OPT, ZISDISMISSED, ZISREAD, ZCREATEDAT, ZUPDATEDAT, ZKINDRAW, ZMESSAGE, ZTITLE, ZCONTACTID, ZID)
     VALUES (?, ?, 1, ?, 0, ?, ?, ?, 'synthetic', 'synthetic', ?, ?)`,
  );
  for (const n of fx.notifications ?? []) {
    const at = n.createdAt ?? created + 200;
    insAN.run(n.pk, E.AppNotification, n.dismissed ? 1 : 0, at, at, n.kind ?? 'fadingRelationship', n.contact ? zid('Contact', n.contact) : null, zid('AppNotification', n.pk));
  }
  const insI = db.prepare(
    `INSERT INTO ZINTERACTION (Z_PK, Z_ENT, Z_OPT, ZCONTACT, ZCREATEDAT, ZDATE, ZDURATION, ZDIRECTIONRAW, ZSUMMARY, ZTYPE, ZID) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const i of fx.interactions ?? []) {
    insI.run(i.pk, E.Interaction, i.contact, i.date, i.date, i.duration ?? null, i.direction ?? null, i.summary ?? null, i.type ?? 'Text', zid('Interaction', i.pk));
  }
  return db;
}
