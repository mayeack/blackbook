/**
 * Ask your network — public surface.
 *   askNetwork(req)                     the engine (web SSE and iMessage share it)        ./engine
 *   answerForImessage(question, ctx)    the `?` command's reply body (≤ 600 chars)         ./imessage
 *   suggestedPrompts(db)                prompts for the empty Ask screen                   ./suggested
 */
export { askNetwork, ASK_TIMEOUT_MS, type AskEngineAnswer, type AskEngineRequest } from './engine';
export { answerForImessage, askForImessage, formatImessageAnswer, IMESSAGE_ANSWER_CHARS, type ImessageAnswer, type ImessageAskContext } from './imessage';
export { NEEDS_KEY_MESSAGE } from './degraded';
export { CONVERSATION_CURSOR, conversationExists, getConversation, listConversations } from './store';
export { suggestedPrompts } from './suggested';
