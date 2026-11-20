import { describe, expect, it } from 'vitest';
import { decideSend, type SendInput } from '@/renderer/services/runtime/RunningInput/decideSend';

const base: SendInput = {
  host: 'busy',
  hostTurnId: 'host-1',
  channel: 'available',
  native: 'active',
  turnKey: 'binding-1/turn-1',
  stop: { status: 'none' },
  draft: { slashCommand: false, hasQuote: false, files: false, sessions: false },
  interrupted: false,
  inFlight: false,
  refreshed: false,
  negotiated: true,
  mode: 'steer',
};

describe('send routing for an explicit click', () => {
  it.each([
    ['idle', 'idle', false, 'ordinary', 'idle'],
    ['idle', 'idle', true, 'ordinary', 'idle'],
    ['busy', 'active', false, 'relay-steer', 'text'],
    ['busy', 'active', true, 'relay-steer', 'text'],
    ['idle', 'active', false, 'keep', 'refresh'],
    ['idle', 'active', true, 'relay-steer', 'text'],
    ['busy', 'idle', false, 'keep', 'refresh'],
    ['busy', 'idle', true, 'keep', 'host'],
    ['unknown', 'idle', true, 'keep', 'host'],
    ['unknown', 'active', true, 'keep', 'host'],
    ['idle', 'unknown', false, 'keep', 'refresh'],
    ['idle', 'unknown', true, 'keep', 'unconfirmed'],
  ] as const)(
    'available channel, host %s / native %s / refreshed %s → %s (%s)',
    (host, native, refreshed, route, reason) => {
      expect(decideSend({ ...base, host, native, refreshed })).toEqual({ route, reason });
    }
  );

  describe.each(['unknown', 'checking', 'unavailable'] as const)('%s channel', (channel) => {
    it.each([
      ['idle', false, 'refresh'],
      ['busy', false, 'refresh'],
      ['unknown', false, 'host'],
      ['idle', true, 'unconfirmed'],
      ['busy', true, 'unconfirmed'],
      ['unknown', true, 'host'],
    ] as const)('host %s / refreshed %s → keep (%s)', (host, refreshed, reason) => {
      expect(decideSend({ ...base, channel, native: 'unknown', turnKey: null, host, refreshed })).toEqual({
        route: 'keep',
        reason,
      });
    });
  });

  it.each([
    ['busy', 'keep'],
    ['idle', 'ordinary'],
    ['unknown', 'keep'],
  ] as const)('uses legacy admission after initial discovery failure (host %s)', (host, route) => {
    expect(decideSend({ ...base, host, channel: 'unavailable', negotiated: false }).route).toBe(route);
  });

  describe.each(['unsupported', 'no-live-task'] as const)('%s channel', (channel) => {
    it.each([
      ['idle', 'ordinary', 'host-only'],
      ['busy', 'keep', 'host'],
      ['unknown', 'keep', 'host'],
    ] as const)('host %s → %s', (host, route, reason) => {
      expect(decideSend({ ...base, channel, host, native: 'unknown', turnKey: null })).toEqual({ route, reason });
    });
  });

  describe.each([
    ['steer', 'relay-steer'],
    ['follow-up', 'relay-follow-up'],
  ] as const)('%s mode', (mode, relay) => {
    it.each([
      [false, false, false, 'text'],
      [true, false, false, 'quoted'],
      [false, true, false, 'references'],
      [false, false, true, 'references'],
      [true, true, true, 'references'],
    ] as const)('quote %s, files %s, sessions %s → %s', (hasQuote, files, sessions, reason) => {
      const draft = { hasQuote, files, sessions, slashCommand: false };
      expect(decideSend({ ...base, draft, mode })).toEqual({ route: relay, reason });
      expect(decideSend({ ...base, draft: { ...draft, slashCommand: true }, mode })).toEqual({
        route: 'keep',
        reason: 'slash',
      });
    });
  });

  it.each([
    ['busy', 'active', true, 'keep'],
    ['busy', 'idle', true, 'keep'],
    ['idle', 'active', true, 'keep'],
    ['idle', 'idle', true, 'ordinary'],
  ] as const)('original slash with quote: host %s, native %s → never relay', (host, native, refreshed, route) => {
    expect(
      decideSend({ ...base, host, native, refreshed, draft: { ...base.draft, slashCommand: true, hasQuote: true } })
        .route
    ).toBe(route);
  });

  it.each([
    ['pending', true, false, 'keep'],
    ['pending', false, false, 'relay-steer'],
    ['done', true, false, 'keep'],
    ['done', false, false, 'relay-steer'],
    ['failed', true, true, 'keep'],
    ['failed', true, false, 'relay-steer'],
    ['failed', false, false, 'relay-steer'],
  ] as const)('Stop %s, same turn %s, interrupted %s → %s', (status, same, interrupted, route) => {
    const stop = { status, turnKey: same ? base.turnKey : 'other', hostTurnId: same ? base.hostTurnId : 'other' };
    expect(decideSend({ ...base, stop, interrupted, refreshed: true }).route).toBe(route);
  });

  it.each([
    ['pending', 'no-live-task', 'keep'],
    ['done', 'no-live-task', 'ordinary'],
    ['pending', 'available', 'keep'],
    ['done', 'available', 'ordinary'],
  ] as const)('Stop %s with no active native turn on an idle host (%s)', (status, channel, route) => {
    const stop = { status, hostTurnId: null, turnKey: base.turnKey };
    expect(
      decideSend({ ...base, stop, host: 'idle', hostTurnId: null, channel, native: 'idle', turnKey: null }).route
    ).toBe(route);
  });

  it.each(['inFlight', 'interrupted'] as const)('%s prevents both ordinary and relay writes', (gate) => {
    expect(decideSend({ ...base, [gate]: true }).route).toBe('keep');
    expect(decideSend({ ...base, host: 'idle', channel: 'no-live-task', [gate]: true }).route).toBe('keep');
  });
});
