import type { RunningInputMode } from './types';

export type HostTurnState = 'idle' | 'busy' | 'unknown';

export type StopState =
  | { status: 'none' }
  | { status: 'pending' | 'failed' | 'done'; turnKey: string | null; hostTurnId: string | null };

export type SendInput = {
  host: HostTurnState;
  hostTurnId: string | null;
  channel: 'unknown' | 'checking' | 'available' | 'no-live-task' | 'unavailable' | 'unsupported';
  native: 'active' | 'idle' | 'unknown';
  turnKey: string | null;
  stop: StopState;
  interrupted: boolean;
  inFlight: boolean;
  refreshed: boolean;
  negotiated: boolean;
  draft: { slashCommand: boolean; hasQuote: boolean; files: boolean; sessions: boolean };
  mode: RunningInputMode;
};

type Decision =
  | { route: 'ordinary'; reason: 'host-only' | 'idle' }
  | { route: 'relay-steer' | 'relay-follow-up'; reason: 'text' | 'quoted' | 'references' }
  | {
      route: 'keep';
      reason: 'interrupted' | 'stop' | 'in-flight' | 'host' | 'slash' | 'refresh' | 'refresh-host' | 'unconfirmed';
    };

/**
 * Route one explicit submission. Evaluate rows in order. A refresh reads state only,
 * then evaluates the table again with the latest host and native observations.
 *
 * | Condition | Decision |
 * | --- | --- |
 * | Submission crossed a Stop, changed session/host turn, or sending is paused | Keep |
 * | Pending Stop on this turn | Keep |
 * | Completed Stop on this still-active turn | Read once, then keep if still active |
 * | Another submission is pending | Keep |
 * | Host unknown on Send | Read the host summary once, then re-evaluate with current channel state |
 * | Host still unknown after that read | Keep until another Send or reconnect can read again |
 * | Unsupported, never negotiated after discovery failure, or confirmed no live task | Ordinary only on idle host |
 * | Original slash prefix, busy host | Keep |
 * | Channel uncertain, or cached native and host activity disagree | Refresh once |
 * | Channel/native still uncertain | Keep |
 * | Available, native idle | Ordinary only on idle host |
 * | Available, native active, original slash prefix (including quoted commands) | Keep |
 * | Available, native active, text/quote/files/@@ | Relay in selected advertised mode |
 *
 * A failed Stop permits a new explicit submission. The interrupted submission retains
 * its own Stop revision. Files and session references must all resolve before dispatch.
 */
export function decideSend(input: SendInput): Decision {
  const { channel, host, native, stop, draft } = input;
  if (input.interrupted) return { route: 'keep', reason: 'interrupted' };
  if (stop.status === 'pending' || stop.status === 'done') {
    const sameNative = input.turnKey !== null && stop.turnKey === input.turnKey;
    const pendingHost = stop.status === 'pending' && stop.hostTurnId === input.hostTurnId;
    const stoppedHost = stop.turnKey === null && stop.hostTurnId !== null && stop.hostTurnId === input.hostTurnId;
    if (pendingHost || sameNative || stoppedHost) {
      return { route: 'keep', reason: stop.status === 'done' && !input.refreshed ? 'refresh' : 'stop' };
    }
  }
  if (input.inFlight) return { route: 'keep', reason: 'in-flight' };
  if (host === 'unknown') return { route: 'keep', reason: input.refreshed ? 'host' : 'refresh-host' };
  if (channel === 'unsupported' || channel === 'no-live-task' || (channel === 'unavailable' && !input.negotiated)) {
    return host === 'idle' ? { route: 'ordinary', reason: 'host-only' } : { route: 'keep', reason: 'host' };
  }
  if (draft.slashCommand && host === 'busy') return { route: 'keep', reason: 'slash' };
  if (
    !input.refreshed &&
    (channel !== 'available' || native === 'unknown' || (host === 'busy') !== (native === 'active'))
  ) {
    return { route: 'keep', reason: 'refresh' };
  }
  if (channel !== 'available' || native === 'unknown') return { route: 'keep', reason: 'unconfirmed' };
  if (native === 'idle') {
    return host === 'idle' ? { route: 'ordinary', reason: 'idle' } : { route: 'keep', reason: 'host' };
  }
  if (draft.slashCommand) return { route: 'keep', reason: 'slash' };
  return {
    route: input.mode === 'steer' ? 'relay-steer' : 'relay-follow-up',
    reason: draft.files || draft.sessions ? 'references' : draft.hasQuote ? 'quoted' : 'text',
  };
}
