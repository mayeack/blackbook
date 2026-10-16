/**
 * Shared episode plumbing for the non-iMessage adapters (adapters/common/episodes.ts). identities.kind already
 * allows every external kind (whatsapp_jid/_lid, instagram_*, partiful_user, beeper_user, addressbook_id), so no
 * table is rebuilt.
 *   - pending_reactions gains `source`: any adapter may park a reaction whose target hasn't arrived yet. Existing
 *     rows are iMessage's. Non-iMessage reaction ids are stored namespaced ("<source>:<id>"), see reactionKey().
 *   - Quoted replies of non-iMessage sources resolve reply_to_source_id once the quoted message lands (iMessage
 *     keeps its own thread-root linking, so its rows stay out of this index).
 */
export const sql = /* sql */ `
ALTER TABLE pending_reactions ADD COLUMN source TEXT NOT NULL DEFAULT 'imessage';
CREATE INDEX pending_reactions_source_target ON pending_reactions(source, target_source_msg_id);

CREATE INDEX msg_reply_src_unresolved ON messages(source, reply_to_source_id)
  WHERE reply_to_msg_id IS NULL AND reply_to_source_id IS NOT NULL AND source <> 'imessage';
`;
