import type { DB } from './connection';
import { sql as init } from './migrations/001_init';
import { sql as partifulTexts } from './migrations/002_partiful_texts';
import { sql as pendingReactions } from './migrations/003_pending_reactions';
import * as sourcesCommon from './migrations/004_sources_common';
import * as beeper from './migrations/005_beeper';
import * as whatsapp from './migrations/006_whatsapp';
import * as partiful from './migrations/007_partiful';
import * as calendar from './migrations/008_calendar';
import * as identity from './migrations/009_identity';
import * as occasions from './migrations/010_occasions';
import * as agentLoop from './migrations/011_agent_loop';
import * as obligations from './migrations/012_obligations';
import * as suggestions from './migrations/013_suggestions';
import * as delivery from './migrations/014_delivery';
import * as commands from './migrations/015_commands';
import * as llm from './migrations/016_llm';
import * as extraction from './migrations/017_extraction';
import * as ask from './migrations/018_ask';
import * as eventsTravel from './migrations/019_events_travel';
import * as evalSets from './migrations/020_eval';
import * as digestParts from './migrations/021_digest_parts';
import * as askPeopleList from './migrations/022_ask_people_list';
import * as partyInvite from './migrations/023_party_invite';
import * as partifulGuestNames from './migrations/024_partiful_guest_names';
import * as calls from './migrations/025_calls';
import * as ticketsMetAt from './migrations/026_tickets_met_at';
import * as commitmentStakes from './migrations/027_commitment_stakes';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Data changes that need code (run after `sql`, in the same transaction). */
  up?: (db: DB) => void;
  /** Rebuilds a table (SQLite's 12-step ALTER): foreign keys are off around it and checked before commit. */
  rebuildsTables?: boolean;
}

/** A migration module: `sql`, plus optional `up` / `rebuildsTables` exports. */
type MigrationModule = Pick<Migration, 'sql' | 'up' | 'rebuildsTables'>;

const slot = (version: number, name: string, m: MigrationModule): Migration => ({
  version,
  name,
  sql: m.sql,
  ...(m.up ? { up: m.up } : {}),
  ...(m.rebuildsTables ? { rebuildsTables: true } : {}),
});

/**
 * Ordered schema migrations; PRAGMA user_version records the last one applied. 5–10 are reserved slots, one per
 * source-adapter workstream, and 11–20 one per agent-loop workstream (ties/graph, obligations, suggestions,
 * delivery, commands, llm, extraction, ask, events/travel, eval), so parallel branches never collide on a version
 * number: each fills only its own file. A slot applied while still empty is never re-run, so every slot must be
 * filled (or carry a `-- no schema changes` comment) before a deploy.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: init },
  { version: 2, name: 'partiful_texts', sql: partifulTexts },
  { version: 3, name: 'pending_reactions', sql: pendingReactions },
  slot(4, 'sources_common', sourcesCommon),
  slot(5, 'beeper', beeper),
  slot(6, 'whatsapp', whatsapp),
  slot(7, 'partiful', partiful),
  slot(8, 'calendar', calendar),
  slot(9, 'identity', identity),
  slot(10, 'occasions', occasions),
  slot(11, 'agent_loop', agentLoop),
  slot(12, 'obligations', obligations),
  slot(13, 'suggestions', suggestions),
  slot(14, 'delivery', delivery),
  slot(15, 'commands', commands),
  slot(16, 'llm', llm),
  slot(17, 'extraction', extraction),
  slot(18, 'ask', ask),
  slot(19, 'events_travel', eventsTravel),
  slot(20, 'eval', evalSets),
  slot(21, 'digest_parts', digestParts),
  slot(22, 'ask_people_list', askPeopleList),
  slot(23, 'party_invite', partyInvite),
  slot(24, 'partiful_guest_names', partifulGuestNames),
  slot(25, 'calls', calls),
  slot(26, 'tickets_met_at', ticketsMetAt),
  slot(27, 'commitment_stakes', commitmentStakes),
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function currentVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Applies pending migrations (up to `to`), each in its own transaction. Returns the versions applied. */
export function migrate(db: DB, to = Infinity): number[] {
  const applied: number[] = [];
  const from = currentVersion(db);
  if (from > LATEST_VERSION) {
    throw new Error(`Database schema v${from} is newer than this build (v${LATEST_VERSION}); refusing to run an older server on it.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= currentVersion(db) || m.version > to) continue;
    const fkOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (m.rebuildsTables && fkOn) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        m.up?.(db);
        if (m.rebuildsTables) {
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length) throw new Error(`Migration ${m.version} (${m.name}) left ${broken.length} broken reference(s).`);
        }
        db.pragma(`user_version = ${m.version}`);
      }).immediate();
    } finally {
      if (m.rebuildsTables && fkOn) db.pragma('foreign_keys = ON');
    }
    applied.push(m.version);
  }
  return applied;
}
