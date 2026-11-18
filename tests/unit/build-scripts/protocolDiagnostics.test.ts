import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  installProtocolDiagnostics,
  observeProtocolFactory,
  safeProtocolError,
} from '../../../scripts/studio-preview/host-release/probes/protocolDiagnostics.mjs';

describe('safe original CDP diagnostics', () => {
  it('captures a real driver error code and contexts before Playwright rewrites the message', async () => {
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
      send: (message: { id: number }) => {
        queueMicrotask(() =>
          transport.onmessage({
            id: message.id,
            error: { code: -32000, message: 'Cannot find context with specified id' },
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
      await expect(context.rawEvaluateJSON('PRIVATE_EVALUATION')).rejects.toThrow('Execution context was destroyed');
      expect(capture.snapshot()).toMatchObject({
        status: 'active',
        errors: [
          {
            code: -32000,
            message: 'Cannot find context with specified id',
            method: 'Runtime.evaluate',
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
