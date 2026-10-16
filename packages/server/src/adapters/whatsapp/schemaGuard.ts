/**
 * Schema guard for the WhatsApp snapshot (PLAN "Ingestion → WhatsApp"): the store is undocumented and changes with
 * app updates, so every column the reader uses is checked with PRAGMA table_info before anything is read. A
 * mismatch is reported as table.column names only (schema, never data) and the pass stops before any write.
 */
import type Database from 'better-sqlite3';

/** Schema name (main = ChatStorage, contacts = ContactsV2, lid = LID) → table → columns the reader uses. */
export const REQUIRED_COLUMNS = {
  main: {
    ZWAMESSAGE: ['Z_PK', 'ZCHATSESSION', 'ZGROUPMEMBER', 'ZISFROMME', 'ZMESSAGETYPE', 'ZGROUPEVENTTYPE', 'ZMESSAGEDATE', 'ZSTANZAID', 'ZTEXT'],
    ZWACHATSESSION: ['Z_PK', 'ZCONTACTJID', 'ZSESSIONTYPE', 'ZPARTNERNAME'],
    ZWAGROUPMEMBER: ['Z_PK', 'ZCHATSESSION', 'ZMEMBERJID', 'ZISACTIVE', 'ZISADMIN'],
    ZWAPROFILEPUSHNAME: ['ZJID', 'ZPUSHNAME'],
  },
  contacts: {
    ZWAADDRESSBOOKCONTACT: ['ZFULLNAME', 'ZWHATSAPPID', 'ZLID'],
  },
  lid: {
    ZWAZACCOUNT: ['ZIDENTIFIER', 'ZPHONENUMBER'],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

/** Used when present with these columns, silently skipped otherwise (a third LID→phone source, lowest precedence). */
export const OPTIONAL_COLUMNS = {
  lid: { ZWAPHONENUMBERLIDPAIR: ['ZLID', 'ZPHONENUMBER'] },
} as const;

export type SchemaName = keyof typeof REQUIRED_COLUMNS;

export interface SchemaCheck {
  /** Every required column of every attached store exists. */
  ok: boolean;
  /** ChatStorage has none of the WhatsApp tables yet (app installed, never linked). */
  empty: boolean;
  /** "schema.TABLE.COLUMN" (or "schema.TABLE" for a missing table). */
  missing: string[];
  /** Optional tables that passed their own check. */
  optional: { lidPairs: boolean };
}

export function tableColumns(db: Database.Database, schema: string, table: string): Set<string> {
  // table_info takes the schema as an argument; names here come from the constants above, never from data.
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).pluck().all(table, schema) as string[];
  return new Set(rows);
}

function missingIn(db: Database.Database, schema: string, tables: Record<string, readonly string[]>): string[] {
  const out: string[] = [];
  for (const [table, cols] of Object.entries(tables)) {
    const have = tableColumns(db, schema, table);
    if (!have.size) {
      out.push(`${schema}.${table}`);
      continue;
    }
    for (const c of cols) if (!have.has(c)) out.push(`${schema}.${table}.${c}`);
  }
  return out;
}

/** Checks main plus the attached contacts / lid stores. */
export function checkSchema(db: Database.Database, attached: { contacts: boolean; lid: boolean }): SchemaCheck {
  const mainTables = Object.keys(REQUIRED_COLUMNS.main);
  const present = mainTables.filter((t) => tableColumns(db, 'main', t).size > 0);
  if (present.length === 0) return { ok: false, empty: true, missing: [], optional: { lidPairs: false } };
  const missing = [
    ...missingIn(db, 'main', REQUIRED_COLUMNS.main),
    ...(attached.contacts ? missingIn(db, 'contacts', REQUIRED_COLUMNS.contacts) : []),
    ...(attached.lid ? missingIn(db, 'lid', REQUIRED_COLUMNS.lid) : []),
  ];
  const lidPairs = attached.lid && missingIn(db, 'lid', OPTIONAL_COLUMNS.lid).length === 0;
  return { ok: missing.length === 0, empty: false, missing, optional: { lidPairs } };
}
