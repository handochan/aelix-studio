/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StudioExtensionsReply, StudioExtensionsRequest, StudioExtensionsTransport } from '@aionui/web-host';
import { useCallback, useRef, useState } from 'react';
import { requestStudioExtensions } from '../client';
import { FlowEnded, type Flow } from './flow';
import { carriesSecret } from './secrets';

/** Asks the user whether a secret may cross the network unencrypted; resolves true to go on. */
export type ConfirmInsecure = () => Promise<boolean>;

/**
 * What `send` gives back: the reply, or `declined` when the user kept a secret from an insecure
 * channel, or the flow it was sent for could not go on before it went out.
 */
export type SendResult = StudioExtensionsReply | 'declined';

/** The code of a refusal; undefined for a reply that is ok. */
export const failureCode = (reply: StudioExtensionsReply): string | undefined =>
  reply.ok ? undefined : (reply as { code: string }).code;

/**
 * The screen's channel to the extension helper. `transport` is the latest transport any reply
 * told (a reply without one, and the time before the first reply, count as `insecure`); it is
 * for the warning banner only and decides nothing.
 *
 * Every request belongs to a flow (`flow.ts`) and goes out only while that flow may still go on.
 * `send` decides from the request itself whether it carries a secret (`carriesSecret`); a
 * request that does goes out only through `deliverSecret`, one after another:
 * 1. the transport is read with a request that carries nothing (`get_settings`), and only that
 *    reply's transport decides;
 * 2. over an insecure channel the user is asked, for this request (2026-11-24 orchestrator
 *    decision: every secret sent over an insecure channel is confirmed on its own; no yes is
 *    kept for the next one); after a yes it carries `acknowledgeInsecureTransport: true`;
 * 3. a request the host still refuses as `INSECURE_TRANSPORT` goes the same way once more.
 * The flow is checked after every await: waiting for the secret before it and the check
 * (`flow.step`), and around the question (`flow.ask`).
 */
export function useExtensionsChannel(confirmInsecure: ConfirmInsecure) {
  /** Secret requests, one after another: no two checks or questions at once. */
  const secrets = useRef<Promise<unknown>>(Promise.resolve());
  const [banner, setBanner] = useState<StudioExtensionsTransport | undefined>(undefined);

  const deliver = useCallback(async (request: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
    const reply = await requestStudioExtensions(request);
    setBanner(reply.transport ?? 'insecure');
    return reply;
  }, []);

  /** One secret request: checked, asked about, and sent only while its flow may go on. */
  const deliverSecret = useCallback(
    async (command: StudioExtensionsRequest, flow: Flow): Promise<SendResult> => {
      const attempt = async (): Promise<SendResult> => {
        const check = await flow.step(deliver({ action: 'get_settings' }));
        // This check's own answer decides, not whichever reply came last.
        if ((check.transport ?? 'insecure') === 'secure') return deliver(command);
        if (!(await flow.ask(confirmInsecure))) return 'declined';
        return deliver({ ...command, acknowledgeInsecureTransport: true });
      };
      try {
        const reply = await attempt();
        if (reply === 'declined' || failureCode(reply) !== 'INSECURE_TRANSPORT') return reply;
        return await attempt();
      } catch (error) {
        if (error instanceof FlowEnded) return 'declined';
        throw error;
      }
    },
    [confirmInsecure, deliver]
  );

  const send = useCallback(
    async (command: StudioExtensionsRequest, flow: Flow): Promise<SendResult> => {
      if (!flow.valid()) return 'declined';
      if (!carriesSecret(command)) return deliver(command);
      const before = secrets.current;
      const turn = (async (): Promise<SendResult> => {
        try {
          await flow.step(before);
        } catch (error) {
          if (error instanceof FlowEnded) return 'declined';
          throw error;
        }
        return deliverSecret(command, flow);
      })();
      secrets.current = turn.catch((): void => {});
      return turn;
    },
    [deliver, deliverSecret]
  );

  return { send, transport: banner };
}
