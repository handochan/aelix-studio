import type { RelayFailure } from './transport';

export type RunningInputMode = 'steer' | 'follow-up';
export type RunningInputTarget = Readonly<{ bindingId: string; turnId: string }>;
export type RunningInputTurn = { active: true; turnId: string } | { active: false; turnId: null };

export type RunningInputOutcome =
  | { status: 'queued' }
  | { status: 'rejected'; reason: 'stale-turn' | 'dedup-capacity' }
  | { status: 'rejected'; failure: RelayFailure }
  | { status: 'unknown'; failure?: RelayFailure };

export type RunningInputReceipt = Readonly<
  RunningInputTarget & { requestId: string; mode: RunningInputMode } & (RunningInputOutcome | { status: 'pending' })
>;

export type RunningInputSnapshot = Readonly<{
  channel:
    | { status: 'checking' | 'unsupported' }
    | { status: 'unavailable'; failure?: RelayFailure }
    | {
        status: 'ready';
        bindingId: string;
        turn: RunningInputTurn;
        modes: readonly RunningInputMode[];
        canLookup: boolean;
      };
  receipts: readonly RunningInputReceipt[];
  sending: boolean;
}>;

export type RunningInputSendResult =
  | { status: 'skipped'; reason: 'busy' | 'unavailable' | 'invalid-text' | 'too-large'; preserveDraft: true }
  | { status: 'sent'; receipt: RunningInputReceipt; preserveDraft: boolean };

export type RunningInputLookupResult =
  | { status: 'completed'; receipt: RunningInputReceipt }
  | { status: 'pending' }
  | { status: 'unknown' | 'unavailable' | 'binding-changed'; refreshHistory: true };
