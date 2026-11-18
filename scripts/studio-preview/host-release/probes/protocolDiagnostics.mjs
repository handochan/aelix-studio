import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const MESSAGES = [
  'Cannot find context with specified id',
  'Cannot find object with given id',
  'Could not find object with given id',
  'Execution context was destroyed.',
  'Inspected target navigated or closed',
  'Execution was terminated',
  'Invalid parameters',
  'Invalid remote object id',
  'Session with given id not found.',
  'No target with given id found',
];
const METHODS = new Set([
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Browser.getVersion',
]);

/** Preserve known CDP diagnostics, never arbitrary remote text or error data. */
export function safeProtocolError(error) {
  const raw = typeof error?.message === 'string' ? error.message : '';
  const prefix = MESSAGES.find((message) => raw.startsWith(message));
  return {
    code: Number.isSafeInteger(error?.code) ? error.code : null,
    message: prefix ? prefix + (raw === prefix ? '' : ' <redacted>') : '<redacted-unrecognized-message>',
    messageRedacted: !prefix || raw !== prefix,
    messageLength: raw.length,
  };
}

/** Tap the existing logger before CRSession discards the CDP code or rewrites errors. */
export function observeProtocolFactory(helper, version, record = () => {}) {
  const original = helper.debugProtocolLogger;
  let active = true;
  let restored = false;
  let connections = 0;
  const events = [];
  const errors = [];
  const emit = (event) => {
    if (!active) return;
    const value = { observedAt: new Date().toISOString(), ...event };
    if (event.kind === 'protocol-error') {
      errors.push({
        ...value,
        precedingContexts: events
          .filter((entry) => entry.kind !== 'protocol-error' && entry.connection === event.connection)
          .slice(-16)
          .map((entry) => ({ ...entry })),
      });
      if (errors.length > 8) errors.shift();
    }
    events.push(value);
    if (events.length > 64) events.shift();
    try {
      record(snapshot());
    } catch {
      // Observation must never alter a protocol result or the smoke outcome.
    }
  };
  const snapshot = () => ({
    status: 'active',
    adapter: 'playwright-debug-protocol-logger/1',
    version,
    connections,
    events: events.map((event) => ({ ...event })),
    errors: errors.map((error) => ({
      ...error,
      precedingContexts: error.precedingContexts.map((event) => ({ ...event })),
    })),
  });
  function loggerFactory(...args) {
    const logger = original.apply(this, args);
    const connection = ++connections;
    const requests = new Map();
    return (direction, message) => {
      try {
        if (active && direction === 'send' && Number.isSafeInteger(message?.id)) {
          const key = `${message.sessionId ?? ''}:${message.id}`;
          requests.set(key, METHODS.has(message.method) ? message.method : 'other');
          if (requests.size > 256) requests.delete(requests.keys().next().value);
        } else if (active && direction === 'receive' && message) {
          if (Number.isSafeInteger(message.id)) {
            const key = `${message.sessionId ?? ''}:${message.id}`;
            const method = requests.get(key) ?? 'unknown';
            requests.delete(key);
            if (message.error)
              emit({
                kind: 'protocol-error',
                connection,
                requestId: message.id,
                method,
                ...safeProtocolError(message.error),
              });
          } else if (message.method === 'Runtime.executionContextCreated') {
            const context = message.params?.context;
            emit({
              kind: 'context-created',
              connection,
              contextId: Number.isSafeInteger(context?.id) ? context.id : null,
              isDefault: typeof context?.auxData?.isDefault === 'boolean' ? context.auxData.isDefault : null,
            });
          } else if (message.method === 'Runtime.executionContextDestroyed') {
            emit({
              kind: 'context-destroyed',
              connection,
              contextId: Number.isSafeInteger(message.params?.executionContextId)
                ? message.params.executionContextId
                : null,
            });
          } else if (message.method === 'Runtime.executionContextsCleared') {
            emit({ kind: 'contexts-cleared', connection });
          }
        }
      } catch {
        // Malformed or newly shaped diagnostics cannot change message dispatch.
      }
      return logger(direction, message);
    };
  }
  helper.debugProtocolLogger = loggerFactory;
  const restore = () => {
    if (!restored && helper.debugProtocolLogger === loggerFactory) helper.debugProtocolLogger = original;
    restored = true;
  };
  return {
    snapshot,
    restore,
    dispose: () => {
      active = false;
      restore();
    },
  };
}

/** Use the installed test runner's pinned in-process driver, without another CDP connection. */
export function installProtocolDiagnostics(record) {
  try {
    const testRequire = createRequire(require.resolve('@playwright/test/package.json'));
    const playwrightRequire = createRequire(testRequire.resolve('playwright/package.json'));
    const core = playwrightRequire.resolve('playwright-core/package.json');
    const version = require(core).version;
    if (version !== '1.58.2') throw new Error('unsupported adapter');
    const { helper } = require(path.join(path.dirname(core), 'lib/server/helper.js'));
    if (typeof helper.debugProtocolLogger !== 'function') throw new Error('missing adapter');
    return observeProtocolFactory(helper, version, record);
  } catch {
    return {
      snapshot: () => ({ status: 'unavailable', reason: 'protocol-adapter-unavailable' }),
      restore() {},
      dispose() {},
    };
  }
}
