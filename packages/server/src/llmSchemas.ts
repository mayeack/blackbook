/**
 * Every schema yeackbot asks Claude to fill: each structured-output schema (output_config.format) with the route
 * that sends it, and the Ask loop's strict tools. The API compiles these into a grammar and refuses a request whose
 * grammar is too large (llm/client.ts GRAMMAR_MAX_NODES), so test/llm/outputSchemas.test.ts keeps each within the
 * budget (and fails on a `schema: X` call site whose X is not listed here), and `yb llm-smoke --live` sends one
 * empty request per entry to the real API. A new LLM call site adds its schema here.
 */
import type { z } from 'zod';
import { TicketEmail } from './adapters/gmail/prompt';
import { ASK_TOOL_DEFS } from './ask/tools';
import { DraftSchema } from './commands/draft';
import { IntentSchema } from './commands/intent';
import { ComposerOutput } from './delivery/llmComposer';
import { Consolidation, ExtractionKnowledge, ExtractionObligations } from './extraction/schema';
import { TiebreakOutput } from './identity/tiebreak';
import type { LlmRoute } from './llm/models';
import type { LlmTool } from './llm/types';
import { EventsExtract } from './intel/eventPicks/discover';
import { NewsletterEvents } from './intel/eventPicks/newsletters';
import { CircleNameOutput } from './pipeline/circles/naming';
import { AdjudicationResult } from './pipeline/occasions/packet';
import { DraftOut } from './pipeline/suggestions/feedback';

export interface LlmSchemaEntry {
  /** The zod constant's name (what call sites pass as `schema: <name>`), or the tool set's. */
  name: string;
  route: LlmRoute;
  schema?: z.ZodType;
  tools?: readonly LlmTool[];
}

export const LLM_SCHEMAS: readonly LlmSchemaEntry[] = [
  { name: 'ExtractionKnowledge', route: 'extract_steady', schema: ExtractionKnowledge },
  { name: 'ExtractionObligations', route: 'extract_steady', schema: ExtractionObligations },
  { name: 'Consolidation', route: 'extract_consolidate', schema: Consolidation },
  { name: 'TiebreakOutput', route: 'tiebreak', schema: TiebreakOutput },
  { name: 'IntentSchema', route: 'intent', schema: IntentSchema },
  { name: 'CircleNameOutput', route: 'circle_name', schema: CircleNameOutput },
  { name: 'AdjudicationResult', route: 'adjudicate', schema: AdjudicationResult },
  { name: 'ComposerOutput', route: 'digest_compose', schema: ComposerOutput },
  { name: 'DraftOut', route: 'draft_openers', schema: DraftOut },
  { name: 'DraftSchema', route: 'draft_openers', schema: DraftSchema },
  { name: 'TicketEmail', route: 'ticket_parse', schema: TicketEmail },
  { name: 'EventsExtract', route: 'events_extract', schema: EventsExtract },
  { name: 'NewsletterEvents', route: 'events_newsletter', schema: NewsletterEvents },
  { name: 'ASK_TOOL_DEFS', route: 'ask_web', tools: ASK_TOOL_DEFS },
];
