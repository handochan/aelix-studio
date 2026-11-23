/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StudioExtensionsReply, StudioExtensionsRequest, StudioExtensionsTransport } from '@aionui/web-host';
import { useCallback, useRef, useState } from 'react';
import { requestStudioExtensions } from '../client';

/** Asks the user whether a secret may cross the network unencrypted; resolves true to go on. */
export type ConfirmInsecure = () => Promise<boolean>;

export type SendOptions = {
  /** The request carries proxy credentials (2026-11-23 user decision: warn, then allow). */
  secret?: boolean;
};

/** What `send` gives back: the reply, or `declined` when the user kept a secret from an insecure channel. */
export type SendResult = StudioExtensionsReply | 'declined';

/** The code of a refusal; undefined for a reply that is ok. */
export const failureCode = (reply: StudioExtensionsReply): string | undefined =>
  reply.ok ? undefined : (reply as { code: string }).code;

/**
 * The screen's channel to the extension helper. It keeps the transport of the latest reply: a
 * reply without one (a refusal before the route, a lost answer) counts as `insecure`, and so
 * does the time before the first reply. Before the first request that carries a secret over an
 * insecure channel it asks the user once for this visit of the screen; after a yes, such
 * requests carry `acknowledgeInsecureTransport: true`. A request the host still answers
 * `INSECURE_TRANSPORT` (the channel became insecure after the last reply) is asked about and
 * sent again once.
 */
export function useExtensionsChannel(confirmInsecure: ConfirmInsecure) {
  const transport = useRef<StudioExtensionsTransport>('insecure');
  const acknowledged = useRef(false);
  const [current, setCurrent] = useState<StudioExtensionsTransport | undefined>(undefined);

  const acknowledge = useCallback(async (): Promise<boolean> => {
    if (acknowledged.current) return true;
    if (!(await confirmInsecure())) return false;
    acknowledged.current = true;
    return true;
  }, [confirmInsecure]);

  const deliver = useCallback(async (request: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
    const reply = await requestStudioExtensions(request);
    transport.current = reply.transport ?? 'insecure';
    setCurrent(transport.current);
    return reply;
  }, []);

  const send = useCallback(
    async (command: StudioExtensionsRequest, options: SendOptions = {}): Promise<SendResult> => {
      if (!options.secret) return deliver(command);
      if (transport.current !== 'secure' && !(await acknowledge())) return 'declined';
      const reply = await deliver(
        transport.current === 'secure' ? command : { ...command, acknowledgeInsecureTransport: true }
      );
      if (failureCode(reply) !== 'INSECURE_TRANSPORT') return reply;
      if (!(await acknowledge())) return 'declined';
      return deliver({ ...command, acknowledgeInsecureTransport: true });
    },
    [acknowledge, deliver]
  );

  return { send, transport: current };
}
