import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  installProtocolDiagnostics,
  observeProtocolFactory,
  safeProtocolError,
} from '../../../scripts/studio-preview/host-release/probes/protocolDiagnostics.mjs';

// Electron 37.10.3's V8 13.8.258.32 inspector literals were checked against
// the fixed binary string table and the pinned source links in the observer.
// These seven messages contain no substitutions for user-provided values.
const INSPECTOR_ERRORS = [
  'Promise was collected',
  'Tearing down inspector/session/context',
  "Couldn't parse value object in call argument",
  'Argument should belong to the same JavaScript world as target object',
  'Uncaught',
  'Internal error',
  'Script execution is prohibited',
];
const FIXED_ERRORS = [
  ...INSPECTOR_ERRORS,
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

describe('safe original CDP diagnostics', () => {
  it.each(['Cannot find context with specified id', 'Promise was collected'])(
    'captures %s and request flags before the real driver rewrites the message',
    async (message) => {
      const require = createRequire(import.meta.url);
      const runner = createRequire(require.resolve('@playwright/test/package.json'));
      const library = createRequire(runner.resolve('playwright/package.json'));
      const base = path.dirname(library.resolve('playwright-core/package.json'));
      const { helper } = require(path.join(base, 'lib/server/helper.js'));
      const { CRConnection } = require(path.join(base, 'lib/server/chromium/crConnection.js'));
      const { CRExecutionContext } = require(path.join(base, 'lib/server/chromium/crExecutionContext.js'));
      const { createRootSdkObject } = require(path.join(base, 'lib/server/instrumentation.js'));
      const transport = {
        onmessage: (_message: unknown) => {},
        onclose: () => {},
        close: () => {},
        send: (request: { id: number }) => {
          queueMicrotask(() =>
            transport.onmessage({
              id: request.id,
              error: { code: -32000, message },
            })
          );
        },
      };
      const record = vi.fn();
      const capture = installProtocolDiagnostics(record);
      try {
        const connection = new CRConnection(createRootSdkObject(), transport, helper.debugProtocolLogger(), {
          recentLogs: () => [],
        });
        transport.onmessage({
          method: 'Runtime.executionContextCreated',
          params: {
            context: { id: 8, name: 'PRIVATE_NAME', origin: 'file:///Users/PRIVATE', auxData: { isDefault: true } },
          },
        });
        transport.onmessage({ method: 'Runtime.executionContextDestroyed', params: { executionContextId: 8 } });
        const context = new CRExecutionContext(connection.rootSession, { id: 8 });
        const call = message === 'Promise was collected';
        const evaluated = call
          ? context.evaluateWithArguments('PRIVATE_EVALUATION', true, { _objectId: 'PRIVATE_HANDLE' }, [], [])
          : context.rawEvaluateJSON('PRIVATE_EVALUATION');
        await expect(evaluated).rejects.toThrow('Execution context was destroyed');
        expect(capture.snapshot()).toMatchObject({
          status: 'active',
          errors: [
            {
              code: -32000,
              message,
              method: call ? 'Runtime.callFunctionOn' : 'Runtime.evaluate',
              awaitPromise: call ? true : null,
              returnByValue: true,
              precedingContexts: [
                { kind: 'context-created', contextId: 8 },
                { kind: 'context-destroyed', contextId: 8 },
              ],
            },
          ],
        });
        expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE');
      } finally {
        capture.dispose();
      }
    }
  );

  it.each(FIXED_ERRORS)('retains only the exact fixed message: %s', (message) => {
    expect(safeProtocolError({ code: -32000, message })).toMatchObject({
      code: -32000,
      message,
      messageRedacted: false,
      messageLength: message.length,
    });
  });

  it.each(FIXED_ERRORS)('fully masks decorated or case-modified constants: %s', (message) => {
    for (const raw of [
      message + ' /Users/PRIVATE/token=PRIVATE42',
      ' ' + message,
      message + '\nPRIVATE',
      message.toLowerCase(),
    ]) {
      const value = safeProtocolError({ message: raw, data: 'PRIVATE' });
      expect(value.message).toBe('<redacted-unrecognized-message>');
      expect(value.messageRedacted).toBe(true);
      expect(JSON.stringify(value)).not.toContain('PRIVATE');
    }
  });

  it('retains only content-free shape metadata for unknown text', () => {
    const raw = '  PRIVATE /Users/PRIVATE:token=１２３\n\tPRIVATE  ';
    const value = safeProtocolError({ code: -32000, message: raw, data: { secret: 'PRIVATE' } });
    expect(value).toEqual({
      code: -32000,
      message: '<redacted-unrecognized-message>',
      messageRedacted: true,
      messageLength: raw.length,
      messageWordCount: 3,
      messageHasNumber: true,
      messageHasSlash: true,
      messageHasColon: true,
      messageHasEquals: true,
    });
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
  });

  it.each([undefined, { code: Number.NaN, message: { private: 'PRIVATE' } }, { message: ' \t\n' }])(
    'does not stringify missing or non-string messages and counts whitespace as no words',
    (error) => {
      expect(safeProtocolError(error)).toMatchObject({
        code: null,
        message: '<redacted-unrecognized-message>',
        messageRedacted: true,
        messageWordCount: 0,
        messageHasNumber: false,
        messageHasSlash: false,
        messageHasColon: false,
        messageHasEquals: false,
      });
      expect(JSON.stringify(safeProtocolError(error))).not.toContain('PRIVATE');
    }
  );

  it.each([
    { params: { awaitPromise: true, returnByValue: false }, expected: { awaitPromise: true, returnByValue: false } },
    { params: { awaitPromise: false, returnByValue: true }, expected: { awaitPromise: false, returnByValue: true } },
    {
      params: { awaitPromise: 'PRIVATE', returnByValue: { private: 'PRIVATE' } },
      expected: { awaitPromise: null, returnByValue: null },
    },
    { params: {}, expected: { awaitPromise: null, returnByValue: null } },
  ])('copies only boolean evaluation flags, never other request values', ({ params, expected }) => {
    const dispatch = vi.fn();
    const helper = { debugProtocolLogger: () => dispatch };
    const capture = observeProtocolFactory(helper, 'fixture');
    const logger = helper.debugProtocolLogger();
    try {
      const request = {
        id: 7,
        method: 'Runtime.callFunctionOn',
        params: { ...params, functionDeclaration: 'PRIVATE', objectId: 'PRIVATE', arguments: [{ value: 'PRIVATE' }] },
      };
      logger('send', request);
      logger('receive', { id: 7, error: { code: -32000, message: 'Promise was collected', data: 'PRIVATE' } });
      expect(capture.snapshot().errors[0]).toMatchObject({ method: 'Runtime.callFunctionOn', ...expected });
      expect(JSON.stringify(capture.snapshot())).not.toContain('PRIVATE');
      expect(dispatch).toHaveBeenCalledWith('send', request);
    } finally {
      capture.dispose();
    }
  });

  it('correlates request flags across sessions with the same request ID', () => {
    const helper = { debugProtocolLogger: () => vi.fn() };
    const capture = observeProtocolFactory(helper, 'fixture');
    const logger = helper.debugProtocolLogger();
    try {
      for (const returnByValue of [false, true])
        logger('send', {
          id: 1,
          sessionId: returnByValue ? 'PRIVATE_B' : 'PRIVATE_A',
          method: 'Runtime.callFunctionOn',
          params: { awaitPromise: true, returnByValue },
        });
      for (const sessionId of ['PRIVATE_B', 'PRIVATE_A'])
        logger('receive', {
          id: 1,
          sessionId,
          error: { message: 'Promise was collected' },
        });
      expect(capture.snapshot().errors.map((error) => error.returnByValue)).toEqual([true, false]);
      expect(JSON.stringify(capture.snapshot())).not.toContain('PRIVATE');
    } finally {
      capture.dispose();
    }
  });

  it('redacts arbitrary remote text, error data, URLs, tokens and suffixes', () => {
    const secret = '/Users/PRIVATE/token-PRIVATE https://host/?token=PRIVATE';
    for (const message of [secret, 'Cannot find context with specified id: ' + secret]) {
      const value = safeProtocolError({ code: -32602, message, data: secret });
      expect(value.code).toBe(-32602);
      expect(value.messageRedacted).toBe(true);
      expect(JSON.stringify(value)).not.toContain('PRIVATE');
    }
  });

  it('retains error-time contexts after a long cleanup stream and does not change dispatch', () => {
    const dispatch = vi.fn();
    const original = () => dispatch;
    const helper = { debugProtocolLogger: original };
    const capture = observeProtocolFactory(helper, 'fixture');
    const logger = helper.debugProtocolLogger();
    try {
      logger('receive', { method: 'Runtime.executionContextCreated', params: { context: { id: 3 } } });
      logger('send', { id: 1, method: 'Runtime.callFunctionOn', params: { secret: 'PRIVATE' } });
      const error = { id: 1, error: { code: -32000, message: 'Cannot find object with given id' } };
      logger('receive', error);
      for (let index = 0; index < 100; index++) logger('receive', { method: 'Runtime.executionContextsCleared' });
      expect(capture.snapshot().events).toHaveLength(64);
      expect(capture.snapshot().errors[0].precedingContexts).toMatchObject([{ kind: 'context-created', contextId: 3 }]);
      expect(dispatch).toHaveBeenCalledWith('receive', error);
    } finally {
      capture.dispose();
    }
    expect(helper.debugProtocolLogger).toBe(original);
  });

  it('isolates observer exceptions from successful protocol traffic', () => {
    const dispatch = vi.fn().mockReturnValue('unchanged');
    const helper = { debugProtocolLogger: () => dispatch };
    const capture = observeProtocolFactory(helper, 'fixture', () => {
      throw new Error('diagnostic sink failed');
    });
    try {
      expect(helper.debugProtocolLogger()('receive', { method: 'Runtime.executionContextsCleared' })).toBe('unchanged');
    } finally {
      capture.dispose();
    }
  });
});
