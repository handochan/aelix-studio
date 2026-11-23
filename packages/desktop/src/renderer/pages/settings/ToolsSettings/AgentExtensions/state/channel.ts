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
 * does the time before the first reply.
 *
 * Right before every request that carries a secret it reads the transport again with a request
 * that carries none (`get_settings`), so a channel that became insecure since the last reply is
 * known before the secret leaves. Over an insecure channel it asks the user once for this visit
 * of the screen; after a yes, such requests carry `acknowledgeInsecureTransport: true`. The yes
 * lasts while the transport stays the same and the screen stays open (a new visit is a new
 * hook). A request the host still answers `INSECURE_TRANSPORT` is never sent again without
 * asking: the user is asked again, even for the verdict already confirmed, and it is sent again
 * once.
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
    const next = reply.transport ?? 'insecure';
    // A yes was for the channel as it was: once it changes, the next secret is asked about again.
    if (next !== transport.current) acknowledged.current = false;
    transport.current = next;
    setCurrent(next);
    return reply;
  }, []);

  const send = useCallback(
    async (command: StudioExtensionsRequest, options: SendOptions = {}): Promise<SendResult> => {
      if (!options.secret) return deliver(command);
      // The channel as it is now, read with nothing secret in the request.
      await deliver({ action: 'get_settings' });
      if (transport.current !== 'secure' && !(await acknowledge())) return 'declined';
      const reply = await deliver(
        transport.current === 'secure' ? command : { ...command, acknowledgeInsecureTransport: true }
      );
      if (failureCode(reply) !== 'INSECURE_TRANSPORT') return reply;
      acknowledged.current = false;
      if (!(await acknowledge())) return 'declined';
      return deliver({ ...command, acknowledgeInsecureTransport: true });
    },
    [acknowledge, deliver]
  );

  return { send, transport: current };
}
