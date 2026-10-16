/**
 * Catalog of the agent-loop API routes (paths relative to /api/v1) and the server module that serves each.
 * A contract test checks every entry is routed and built (never 501), so a path can't silently go missing.
 * Request/response schemas are named in `req` / `res`.
 */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  /** packages/server/src/<module> that serves it. */
  module: string;
  req?: string;
  res: string;
  /** text/event-stream instead of JSON. */
  sse?: true;
}

const r = (method: HttpMethod, path: string, module: string, res: string, req?: string, sse?: true): RouteSpec => ({
  method,
  path,
  module,
  res,
  ...(req ? { req } : {}),
  ...(sse ? { sse } : {}),
});

export const AGENT_ROUTES: readonly RouteSpec[] = [
  // settings (Foundation)
  r('GET', '/settings', 'settings/routes.ts', 'SettingsResponse'),
  r('PATCH', '/settings', 'settings/routes.ts', 'SettingsPatchResult', 'SettingsPatch'),
  r('GET', '/settings/do-not-merge', 'settings/routes.ts', 'DoNotMergeList'),
  r('DELETE', '/settings/do-not-merge/:a/:b', 'settings/routes.ts', 'BatchRef'),
  r('GET', '/settings/my-identities', 'settings/routes.ts', 'MyIdentities'),
  r('GET', '/settings/export', 'settings/routes.ts', 'DataExport'),
  // today
  r('GET', '/today', 'routes/today.ts', 'TodayResponse', 'TodayQuery'),
  // suggestions
  r('GET', '/suggestions', 'routes/suggestions.ts', 'SuggestionList', 'SuggestionListQuery'),
  r('POST', '/suggestions/:id/feedback', 'routes/suggestions.ts', 'SuggestionFeedbackResult', 'SuggestionFeedback'),
  r('GET', '/suggestions/:id/why', 'routes/suggestions.ts', 'WhyThis'),
  // learner
  r('GET', '/learner', 'routes/learner.ts', 'LearnerState'),
  r('POST', '/learner/reset', 'routes/learner.ts', 'LearnerResetResult', 'LearnerReset'),
  r('POST', '/learner/unmute', 'routes/learner.ts', 'OkResult', 'LearnerUnmute'),
  // person extensions + pair page + loops + notes
  r('GET', '/people/:id/ties', 'routes/personExtras.ts', 'TieStats'),
  r('GET', '/people/:id/facts', 'routes/personExtras.ts', 'PersonFacts'),
  r('POST', '/people/:id/facts/:factId/wrong', 'routes/personExtras.ts', 'BatchRef', 'FactWrong'),
  r('GET', '/people/:id/loops', 'routes/personExtras.ts', 'OpenLoopList'),
  r('GET', '/people/:id/starters', 'routes/personExtras.ts', 'Starters'),
  r('GET', '/people/:id/connections', 'routes/personExtras.ts', 'Connections'),
  r('POST', '/people/:id/connections/:otherId/wrong', 'routes/personExtras.ts', 'BatchRef', 'ConnectionWrong'),
  r('GET', '/people/:id/notes', 'routes/personExtras.ts', 'NoteList'),
  r('POST', '/people/:id/notes', 'routes/personExtras.ts', 'NoteWriteResult', 'NoteCreate'),
  r('PATCH', '/notes/:noteId', 'routes/personExtras.ts', 'NoteWriteResult', 'NoteUpdate'),
  r('DELETE', '/notes/:noteId', 'routes/personExtras.ts', 'BatchRef'),
  r('GET', '/people/:id/merges', 'routes/personExtras.ts', 'MergeHistory'),
  r('POST', '/people/:id/merges/:mergeId/split', 'routes/personExtras.ts', 'BatchRef'),
  r('GET', '/people/:id/collections', 'routes/personExtras.ts', 'PersonCollections'),
  r('POST', '/people/:id/collections', 'routes/personExtras.ts', 'BatchRef', 'CollectionMembershipEdit'),
  r('GET', '/people/:a/with/:b', 'routes/personExtras.ts', 'PairView'),
  r('GET', '/loops', 'routes/personExtras.ts', 'OpenLoopList'),
  r('POST', '/loops/:type/:id', 'routes/personExtras.ts', 'BatchRef', 'LoopAction'),
  // network
  r('GET', '/network', 'routes/network.ts', 'NetworkGraph', 'NetworkQuery'),
  // circles / tags / locations
  ...(['circles', 'tags', 'locations'] as const).flatMap((c) => [
    r('GET', `/${c}`, 'routes/circles.ts', 'CollectionList', 'CollectionListQuery'),
    r('GET', `/${c}/:id`, 'routes/circles.ts', 'CollectionDetail'),
    r('POST', `/${c}`, 'routes/circles.ts', 'CollectionWriteResult', 'CollectionCreate'),
    r('PATCH', `/${c}/:id`, 'routes/circles.ts', 'BatchRef', 'CollectionUpdate'),
    r('POST', `/${c}/:id/members`, 'routes/circles.ts', 'BatchRef', 'CollectionMembersEdit'),
    r('DELETE', `/${c}/:id`, 'routes/circles.ts', 'BatchRef'),
  ]),
  // ask
  r('POST', '/ask', 'routes/ask.ts', 'AskEvent', 'AskRequest', true),
  r('GET', '/ask/conversations', 'routes/ask.ts', 'AskConversationList'),
  r('GET', '/ask/conversations/:id', 'routes/ask.ts', 'AskConversation'),
  // alerts
  r('GET', '/alerts', 'routes/alerts.ts', 'AlertList', 'AlertListQuery'),
  r('POST', '/alerts/:id/dismiss', 'routes/alerts.ts', 'OkResult'),
  // push
  r('GET', '/push/vapid', 'routes/push.ts', 'PushVapid'),
  r('GET', '/push/devices', 'routes/push.ts', 'PushDevices'),
  r('POST', '/push/subscribe', 'routes/push.ts', 'PushSubscribeResult', 'PushSubscribe'),
  r('POST', '/push/unsubscribe', 'routes/push.ts', 'OkResult', 'PushUnsubscribe'),
  r('POST', '/push/test', 'routes/push.ts', 'PushTestResult', 'PushTest'),
  // eval
  r('GET', '/eval/items', 'routes/eval.ts', 'EvalItemPage', 'EvalItemsQuery'),
  r('POST', '/eval/labels', 'routes/eval.ts', 'EvalLabelResult', 'EvalLabelInput'),
  r('GET', '/eval/report', 'routes/eval.ts', 'EvalReport'),
  // digest
  r('GET', '/digest/preview', 'routes/digest.ts', 'DigestPreview', 'DigestPreviewQuery'),
  r('POST', '/digest/send-test', 'routes/digest.ts', 'DigestSendTestResult', 'DigestSendTest'),
  r('GET', '/digest/history', 'routes/digest.ts', 'DigestHistory'),
  // event & travel intel
  r('GET', '/events/:id/brief', 'routes/intel.ts', 'EventBrief'),
  r('GET', '/trips', 'routes/intel.ts', 'TripsResponse', 'TripsQuery'),
];

/** Routes served by one module. */
export const routesOf = (module: string): RouteSpec[] => AGENT_ROUTES.filter((x) => x.module === module);
