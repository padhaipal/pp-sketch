// Best-effort provenance for audit/debugging — identifies which code path
// recorded the send. Not guaranteed to be exhaustive or correct as flows
// evolve: a future consumer that forgets to identify itself records
// 'other' (the default) rather than failing or mislabeling.
export const OUTBOUND_TRIGGERS = [
  'inbound-reply',
  'new-user-onboarding',
  'evening-reminder',
  'hail-mary',
  'morning-update',
  'other',
] as const;
export type OutboundTrigger = (typeof OUTBOUND_TRIGGERS)[number];

// One sent item — always entity-backed. Dynamic text with no media entity
// (sentence prompts, referral links) is NOT logged until sentences are
// persisted as media entities (future work); a comment marks each skip at
// the send sites.
export interface OutboundSentItem {
  media_metadata_id: string;
  state_transition_id?: string | null;
}

export interface RecordSentOptions {
  user_id: string;
  user_message_id?: string | null;
  trigger?: OutboundTrigger;
  items: OutboundSentItem[];
}
