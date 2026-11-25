import { createGlobalResources } from './global';
import { decode, loadRecovery, token } from './parse';
import { createSessionResources } from './session';
import type { ResourceFailure } from './types';

export type * from './types';

/**
 * Create an in-memory NativeResources client for one authenticated owner lifetime.
 * Keep the client while that owner is active. Call `dispose()` on logout, owner change,
 * or unmount, then create a fresh client for the next owner. Owner identity is supplied by
 * the existing transport and is never sent as a parameter. Each tab owns its own snapshots.
 *
 * Session workflows start with `session(conversationId).discover()` after attach. Use the
 * returned capability flags to enable the corresponding actions. Call the session's
 * `invalidate()` before reconnect or detach, then discover again on attach. A binding ID
 * from discovery is required for explicit profile and tool writes.
 *
 * `listProfiles` and `listSelections` start a snapshot. Pass the latest successful list
 * DTO back to `nextProfiles` or `nextSelections` to extend that snapshot. Read `complete`
 * before treating it as a whole list. An expired cursor causes the read to restart at
 * page one. `profileView()` combines the catalog with the latest inspected preview.
 * `showProfile` inspects the current winner by name. `peekSelections` returns the latest
 * immutable snapshot if present. Re-list on screen return to observe external changes.
 *
 * `useProfile(bindingId, ref)` takes the complete ref from preview, or null to clear it.
 * `setActiveTools(bindingId, [])` applies an explicit empty override. A reported null
 * override means inherit. `setProjectSelections` and global `setSelections` take
 * the current listing and edits for keys in it. Global writes pass the listing's
 * revision through to the helper's conditional writer. Call `global.invalidate()`
 * when the selected runtime or root changes.
 *
 * Mutations send one request. A write report describes the outcome, any original-binding
 * receipt status, and the fresh list if available. Treat apply results and observed
 * rows separately from a successful save. A state read cannot settle an unknown write.
 * Use discovery or list reads to check again and require a new explicit choice before
 * making another write. Profile writes refresh the profile and advertised tool/skill
 * catalogs. Existing model controls own their own refresh.
 */
export function createNativeResources() {
  const owner = new AbortController();
  const sessions = new Map<string, ReturnType<typeof createSessionResources>>();
  const global = createGlobalResources(owner.signal);
  return {
    global,
    session(conversationId: string) {
      if (owner.signal.aborted) throw new Error('NativeResources client is disposed');
      if (!decode(token, conversationId) || conversationId === '.' || conversationId === '..') {
        throw new TypeError('Invalid conversation ID');
      }
      let session = sessions.get(conversationId);
      if (!session) {
        session = createSessionResources(conversationId, owner.signal);
        sessions.set(conversationId, session);
      }
      return session;
    },
    dispose() {
      owner.abort();
      sessions.clear();
    },
  };
}

export type NativeResources = ReturnType<typeof createNativeResources>;
export type NativeSessionResources = ReturnType<NativeResources['session']>;
export type NativeGlobalResources = NativeResources['global'];

/**
 * Convert a structured session/load RPC error from the existing open flow when it is
 * available. Pass the error object itself. H1 only exposes the RPC code for relay errors.
 */
export function parseProfileLoadRecovery(error: unknown): ResourceFailure | undefined {
  return decode(loadRecovery, error);
}
