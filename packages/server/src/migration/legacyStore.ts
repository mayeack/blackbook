/**
 * Reader for a snapshot of the legacy SwiftData store. Entity numbers come from Z_PRIMARYKEY and many-to-many
 * join tables (Z_3TAGS, Z_3GROUPS, …) are discovered from the schema at runtime, because Core Data renumbers
 * entities and suffixes join columns whenever the model changes.
 */
import type { DB } from '../db/connection';
import {
  cleanList,
  coreDataMs,
  decodeStringArray,
  parseCustomFields,
  PlistShapeError,
  zidToUuid,
  type PlistEncoding,
} from './convert';

export class LegacySchemaError extends Error {
  constructor(readonly problems: string[]) {
    super(`legacy store schema not understood: ${problems.join('; ')}`);
    this.name = 'LegacySchemaError';
  }
}

export interface DecodeFailure {
  entity: string;
  pk: number;
  column: string;
  reason: string;
}

export interface LegacyContact {
  pk: number;
  uuid: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
  /** raw ZBIRTHDAY (Core Data seconds) */
  birthday: number | null;
  familyDetails: string | null;
  isHidden: boolean;
  isPriority: boolean;
  isMergedAway: boolean;
  mergedIntoPk: number | null;
  metViaPk: number | null;
  cnContactIdentifier: string | null;
  instagramHandle: string | null;
  twitterHandle: string | null;
  linkedInURL: string | null;
  phones: string[];
  emails: string[];
  addresses: string[];
  interests: string[];
  custom: Record<string, string> | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface LegacyCollection {
  pk: number;
  uuid: string;
  name: string;
  colorHex: string | null;
  icon: string | null;
}

export interface LegacyNote {
  pk: number;
  uuid: string;
  contactPk: number | null;
  content: string;
  category: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface LegacyActivity {
  pk: number;
  uuid: string;
  name: string;
  description: string | null;
  colorHex: string | null;
  icon: string | null;
  date: number | null;
  endDate: number | null;
  googleEventId: string | null;
  createdAt: number | null;
}

export interface LegacyReminder {
  pk: number;
  uuid: string;
  contactPk: number | null;
  title: string;
  dueDate: number | null;
  isCompleted: boolean;
  recurrence: string | null;
  createdAt: number | null;
}

export interface LegacyRelationship {
  pk: number;
  uuid: string;
  fromPk: number | null;
  toPk: number | null;
  label: string | null;
  strength: number | null;
}

export interface LegacyNotification {
  pk: number;
  uuid: string;
  kind: string | null;
  contactUuid: string | null;
  isDismissed: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface LegacyInteraction {
  pk: number;
  uuid: string;
  contactPk: number | null;
  type: string | null;
  date: number | null;
  durationS: number | null;
  direction: 'sent' | 'received' | null;
  summary: string | null;
}

/** (aPk, bPk) rows of a many-to-many join table, oriented as the caller asked. */
export type Link = [number, number];

export interface JoinTable {
  table: string;
  /** column holding the first entity's Z_PK, then the second's */
  columns: [string, string];
}

export interface SourceCounts {
  contacts: number;
  mergedAway: number;
  mergedAwayWithPointer: number;
  tags: number;
  tagLinks: number;
  groups: number;
  groupLinks: number;
  locations: number;
  locationLinks: number;
  notes: number;
  activities: number;
  activityContactLinks: number;
  activityGroupLinks: number;
  reminders: number;
  relationships: number;
  metVia: number;
  appNotifications: number;
  appNotificationsDismissed: number;
  interactions: number;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown) => Number(v ?? 0) !== 0;

export class LegacyStore {
  readonly entities = new Map<string, number>();
  private readonly joins: { table: string; cols: { col: string; ent: number }[] }[] = [];
  private readonly columns = new Map<string, Set<string>>();
  readonly decodeFailures: DecodeFailure[] = [];
  readonly plistEncodings: Record<PlistEncoding, number> = { empty: 0, plain: 0, keyed_archive: 0 };
  readonly uuidFailures: { entity: string; pk: number }[] = [];

  constructor(readonly db: DB) {
    const problems: string[] = [];
    const hasPk = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Z_PRIMARYKEY'").get();
    if (!hasPk) throw new LegacySchemaError(['no Z_PRIMARYKEY table (not a Core Data store?)']);
    for (const r of db.prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY').all() as { Z_ENT: number; Z_NAME: string }[]) {
      this.entities.set(r.Z_NAME, r.Z_ENT);
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[];
    for (const t of tables) {
      const cols = (db.pragma(`table_info(${q(t)})`) as { name: string }[]).map((c) => c.name);
      this.columns.set(t, new Set(cols));
      if (!/^Z_\d+[A-Z0-9]+$/.test(t) || cols.length !== 2) continue;
      const parsed = cols.map((col) => ({ col, m: /^Z_(\d+)[A-Z]+\d*$/.exec(col) }));
      if (parsed.every((p) => p.m)) this.joins.push({ table: t, cols: parsed.map((p) => ({ col: p.col, ent: Number(p.m![1]) })) });
    }
    for (const name of ['Contact']) if (!this.entities.has(name)) problems.push(`entity ${name} missing from Z_PRIMARYKEY`);
    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
      if (!this.columns.has(table)) {
        if (table === 'ZCONTACT') problems.push('table ZCONTACT missing');
        continue;
      }
      for (const c of cols) if (!this.columns.get(table)!.has(c)) problems.push(`${table}.${c} missing`);
    }
    if (problems.length) throw new LegacySchemaError(problems);
  }

  hasTable(table: string): boolean {
    return this.columns.has(table);
  }

  private has(table: string, column: string): boolean {
    return this.columns.get(table)?.has(column) ?? false;
  }

  /** The many-to-many table between two entities, by entity number (not by name). */
  joinTable(a: string, b: string): JoinTable | null {
    const ea = this.entities.get(a);
    const eb = this.entities.get(b);
    if (ea === undefined || eb === undefined || ea === eb) return null;
    const hits = this.joins.filter((j) => j.cols.some((c) => c.ent === ea) && j.cols.some((c) => c.ent === eb));
    if (hits.length > 1) throw new LegacySchemaError([`ambiguous join tables between ${a} and ${b}: ${hits.map((h) => h.table).join(', ')}`]);
    const j = hits[0];
    if (!j) return null;
    return { table: j.table, columns: [j.cols.find((c) => c.ent === ea)!.col, j.cols.find((c) => c.ent === eb)!.col] };
  }

  links(a: string, b: string): { join: JoinTable | null; rows: Link[] } {
    const join = this.joinTable(a, b);
    if (!join) return { join, rows: [] };
    const rows = this.db
      .prepare(`SELECT ${q(join.columns[0])} AS a, ${q(join.columns[1])} AS b FROM ${q(join.table)} ORDER BY 1, 2`)
      .all() as { a: number; b: number }[];
    return { join, rows: rows.map((r) => [Number(r.a), Number(r.b)] as Link) };
  }

  private uuid(entity: string, pk: number, v: unknown): string {
    const u = zidToUuid(v);
    if (!u) {
      this.uuidFailures.push({ entity, pk });
      return '';
    }
    return u;
  }

  private list(entity: string, pk: number, column: string, v: unknown): string[] {
    try {
      const { values, encoding } = decodeStringArray(v);
      this.plistEncodings[encoding]++;
      return cleanList(values);
    } catch (e) {
      this.decodeFailures.push({ entity, pk, column, reason: e instanceof PlistShapeError ? e.reason : 'decode error' });
      return [];
    }
  }

  private rows(table: string, order = 'Z_PK'): Record<string, unknown>[] {
    if (!this.hasTable(table)) return [];
    return this.db.prepare(`SELECT * FROM ${q(table)} ORDER BY ${order}`).all() as Record<string, unknown>[];
  }

  contacts(): LegacyContact[] {
    return this.rows('ZCONTACT').map((r) => {
      const pk = Number(r.Z_PK);
      let custom: Record<string, string> | null = null;
      try {
        custom = parseCustomFields(r.ZCUSTOMFIELDS);
      } catch (e) {
        this.decodeFailures.push({ entity: 'Contact', pk, column: 'ZCUSTOMFIELDS', reason: (e as PlistShapeError).reason ?? 'decode error' });
      }
      return {
        pk,
        uuid: this.uuid('Contact', pk, r.ZID),
        firstName: text(r.ZFIRSTNAME),
        lastName: text(r.ZLASTNAME),
        company: text(r.ZCOMPANY),
        jobTitle: text(r.ZJOBTITLE),
        birthday: r.ZBIRTHDAY === null || r.ZBIRTHDAY === undefined ? null : Number(r.ZBIRTHDAY),
        familyDetails: text(r.ZFAMILYDETAILS),
        isHidden: bool(r.ZISHIDDEN),
        isPriority: bool(r.ZISPRIORITY),
        isMergedAway: bool(r.ZISMERGEDAWAY),
        mergedIntoPk: int(r.ZMERGEDINTOCONTACT),
        metViaPk: int(r.ZMETVIA),
        cnContactIdentifier: text(r.ZCNCONTACTIDENTIFIER),
        instagramHandle: text(r.ZINSTAGRAMHANDLE),
        twitterHandle: text(r.ZTWITTERHANDLE),
        linkedInURL: text(r.ZLINKEDINURL),
        phones: this.list('Contact', pk, 'ZPHONES', r.ZPHONES),
        emails: this.list('Contact', pk, 'ZEMAILS', r.ZEMAILS),
        addresses: this.list('Contact', pk, 'ZADDRESSES', r.ZADDRESSES),
        interests: this.list('Contact', pk, 'ZINTERESTS', r.ZINTERESTS),
        custom,
        createdAt: coreDataMs(r.ZCREATEDAT),
        updatedAt: coreDataMs(r.ZUPDATEDAT),
      };
    });
  }

  private collections(table: string, entity: string): LegacyCollection[] {
    return this.rows(table).map((r) => {
      const pk = Number(r.Z_PK);
      return {
        pk,
        uuid: this.uuid(entity, pk, r.ZID),
        name: text(r.ZNAME) ?? `(unnamed ${entity.toLowerCase()} ${pk})`,
        colorHex: text(r.ZCOLORHEX),
        icon: this.has(table, 'ZICON') ? text(r.ZICON) : null,
      };
    });
  }

  tags = () => this.collections('ZTAG', 'Tag');
  groups = () => this.collections('ZGROUP', 'Group');
  locations = () => this.collections('ZLOCATION', 'Location');

  notes(): LegacyNote[] {
    return this.rows('ZNOTE').map((r) => {
      const pk = Number(r.Z_PK);
      return {
        pk,
        uuid: this.uuid('Note', pk, r.ZID),
        contactPk: int(r.ZCONTACT),
        content: typeof r.ZCONTENT === 'string' ? r.ZCONTENT : '',
        category: text(r.ZCATEGORY),
        createdAt: coreDataMs(r.ZCREATEDAT),
        updatedAt: coreDataMs(r.ZUPDATEDAT),
      };
    });
  }

  activities(): LegacyActivity[] {
    return this.rows('ZACTIVITY').map((r) => {
      const pk = Number(r.Z_PK);
      return {
        pk,
        uuid: this.uuid('Activity', pk, r.ZID),
        name: text(r.ZNAME) ?? '(untitled activity)',
        description: text(r.ZACTIVITYDESCRIPTION),
        colorHex: text(r.ZCOLORHEX),
        icon: text(r.ZICON),
        date: coreDataMs(r.ZDATE),
        endDate: coreDataMs(r.ZENDDATE),
        googleEventId: text(r.ZGOOGLEEVENTID),
        createdAt: coreDataMs(r.ZCREATEDAT),
      };
    });
  }

  reminders(): LegacyReminder[] {
    return this.rows('ZREMINDER').map((r) => {
      const pk = Number(r.Z_PK);
      return {
        pk,
        uuid: this.uuid('Reminder', pk, r.ZID),
        contactPk: int(r.ZCONTACT),
        title: text(r.ZTITLE) ?? '(reminder)',
        dueDate: coreDataMs(r.ZDUEDATE),
        isCompleted: bool(r.ZISCOMPLETED),
        recurrence: text(r.ZRECURRENCE),
        createdAt: coreDataMs(r.ZCREATEDAT),
      };
    });
  }

  relationships(): LegacyRelationship[] {
    return this.rows('ZCONTACTRELATIONSHIP').map((r) => {
      const pk = Number(r.Z_PK);
      return {
        pk,
        uuid: this.uuid('ContactRelationship', pk, r.ZID),
        fromPk: int(r.ZFROMCONTACT),
        toPk: int(r.ZTOCONTACT),
        label: text(r.ZLABEL),
        strength: r.ZSTRENGTH === null || r.ZSTRENGTH === undefined ? null : Number(r.ZSTRENGTH),
      };
    });
  }

  notifications(): LegacyNotification[] {
    return this.rows('ZAPPNOTIFICATION').map((r) => {
      const pk = Number(r.Z_PK);
      return {
        pk,
        uuid: this.uuid('AppNotification', pk, r.ZID),
        kind: text(r.ZKINDRAW),
        contactUuid: zidToUuid(r.ZCONTACTID),
        isDismissed: bool(r.ZISDISMISSED),
        createdAt: coreDataMs(r.ZCREATEDAT),
        updatedAt: coreDataMs(r.ZUPDATEDAT),
      };
    });
  }

  interactions(): LegacyInteraction[] {
    return this.rows('ZINTERACTION').map((r) => {
      const pk = Number(r.Z_PK);
      const dir = text(r.ZDIRECTIONRAW)?.toLowerCase();
      return {
        pk,
        uuid: this.uuid('Interaction', pk, r.ZID),
        contactPk: int(r.ZCONTACT),
        type: text(r.ZTYPE),
        date: coreDataMs(r.ZDATE),
        durationS: r.ZDURATION === null || r.ZDURATION === undefined ? null : Number(r.ZDURATION),
        direction: dir === 'sent' ? 'sent' : dir === 'received' ? 'received' : null,
        summary: typeof r.ZSUMMARY === 'string' ? r.ZSUMMARY : null,
      };
    });
  }

  private count(table: string, where = ''): number {
    if (!this.hasTable(table)) return 0;
    return Number(this.db.prepare(`SELECT count(*) FROM ${q(table)} ${where}`).pluck().get());
  }

  private linkCount(a: string, b: string): number {
    const j = this.joinTable(a, b);
    return j ? this.count(j.table) : 0;
  }

  /** Row counts at snapshot time: verification compares against these, never hard-coded numbers. */
  counts(): SourceCounts {
    return {
      contacts: this.count('ZCONTACT'),
      mergedAway: this.count('ZCONTACT', 'WHERE ZISMERGEDAWAY = 1'),
      mergedAwayWithPointer: this.count('ZCONTACT', 'WHERE ZISMERGEDAWAY = 1 AND ZMERGEDINTOCONTACT IS NOT NULL'),
      tags: this.count('ZTAG'),
      tagLinks: this.linkCount('Contact', 'Tag'),
      groups: this.count('ZGROUP'),
      groupLinks: this.linkCount('Contact', 'Group'),
      locations: this.count('ZLOCATION'),
      locationLinks: this.linkCount('Contact', 'Location'),
      notes: this.count('ZNOTE'),
      activities: this.count('ZACTIVITY'),
      activityContactLinks: this.linkCount('Activity', 'Contact'),
      activityGroupLinks: this.linkCount('Activity', 'Group'),
      reminders: this.count('ZREMINDER'),
      relationships: this.count('ZCONTACTRELATIONSHIP'),
      metVia: this.count('ZCONTACT', 'WHERE ZMETVIA IS NOT NULL'),
      appNotifications: this.count('ZAPPNOTIFICATION'),
      appNotificationsDismissed: this.count('ZAPPNOTIFICATION', 'WHERE ZISDISMISSED = 1'),
      interactions: this.count('ZINTERACTION'),
    };
  }
}

/** Columns the mapping reads; a missing one aborts the run (schema guard). */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  ZCONTACT: [
    'Z_PK', 'ZID', 'ZFIRSTNAME', 'ZLASTNAME', 'ZCOMPANY', 'ZJOBTITLE', 'ZBIRTHDAY', 'ZFAMILYDETAILS', 'ZISHIDDEN',
    'ZISPRIORITY', 'ZISMERGEDAWAY', 'ZMERGEDINTOCONTACT', 'ZMETVIA', 'ZCNCONTACTIDENTIFIER', 'ZINSTAGRAMHANDLE',
    'ZTWITTERHANDLE', 'ZLINKEDINURL', 'ZPHONES', 'ZEMAILS', 'ZADDRESSES', 'ZINTERESTS', 'ZCUSTOMFIELDS', 'ZCREATEDAT',
    'ZUPDATEDAT',
  ],
  ZTAG: ['Z_PK', 'ZID', 'ZNAME', 'ZCOLORHEX'],
  ZGROUP: ['Z_PK', 'ZID', 'ZNAME', 'ZCOLORHEX', 'ZICON'],
  ZLOCATION: ['Z_PK', 'ZID', 'ZNAME', 'ZCOLORHEX', 'ZICON'],
  ZNOTE: ['Z_PK', 'ZID', 'ZCONTACT', 'ZCONTENT', 'ZCATEGORY', 'ZCREATEDAT'],
  ZACTIVITY: ['Z_PK', 'ZID', 'ZNAME', 'ZDATE', 'ZENDDATE', 'ZACTIVITYDESCRIPTION', 'ZGOOGLEEVENTID'],
  ZREMINDER: ['Z_PK', 'ZID', 'ZCONTACT', 'ZTITLE', 'ZDUEDATE', 'ZISCOMPLETED'],
  ZCONTACTRELATIONSHIP: ['Z_PK', 'ZID', 'ZFROMCONTACT', 'ZTOCONTACT', 'ZLABEL'],
  ZAPPNOTIFICATION: ['Z_PK', 'ZID', 'ZCONTACTID', 'ZISDISMISSED', 'ZKINDRAW'],
  ZINTERACTION: ['Z_PK', 'ZID', 'ZCONTACT', 'ZTYPE', 'ZDATE', 'ZDIRECTIONRAW', 'ZSUMMARY'],
};
