/**
 * WhatsApp snapshot adapter (adapters/whatsapp/). No schema changes: it writes only shared tables. Its Z_PK
 * watermark and re-link anchor live in source_cursors (source 'whatsapp', scope 'zpk'); messages are keyed
 * '{chat_jid}:{ZSTANZAID}' in messages(source, source_msg_id); identities use the existing phone / whatsapp_lid
 * kinds; names go to alias_obs.
 */
export const sql = /* sql */ `-- no schema changes`;
