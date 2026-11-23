/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StudioExtensionsReply, StudioExtensionsRequest, StudioExtensionsTransport } from '@aionui/web-host';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestStudioExtensions } from '../client';

/** Asks the user whether a secret may cross the network unencrypted; resolves true to go on. */
export type ConfirmInsecure = () => Promise<boolean>;

export type SendOptions = {
  /** The request carries proxy credentials (2026-11-23 user decision: warn, then allow). */
  secret?: boolean;
};

/**
 * What `send` gives back: the reply, or `declined` when the user kept a secret from an insecure
 * channel, or the screen it was sent from was left before the secret went out.
 */
export type SendResult = StudioExtensionsReply | 'declined';

/** The code of a refusal; undefined for a reply that is ok. */
export const failureCode = (reply: StudioExtensionsReply): string | undefined =>
  reply.ok ? undefined : (reply as { code: string }).code;

/**
 * The screen's channel to the extension helper. It keeps the transport of the latest reply: a
 * reply without one (a refusal before the route, a lost answer) counts as `insecure`, and so
 * does the time before the first reply.
 *
 * Every request that carries a secret, the first time or sent again, goes the same way:
 * 1. the transport is read again with a request that carries none (`get_settings`), so a
 *    channel that became insecure since the last reply is known before the secret leaves;
 * 2. over an insecure channel the user is asked, once for this visit of the screen; after a yes
 *    such requests carry `acknowledgeInsecureTransport: true`. The yes lasts while the transport
 *    stays the same and the screen stays open (a new visit is a new hook);
 * 3. the secret goes only if the screen that asked is still open: a screen left while waiting
 *    for the check or for the user sends nothing.
 *
 * A request the host still answers `INSECURE_TRANSPORT` is never sent again without asking: the
 * user is asked again, even for the verdict already confirmed, and it goes the same way once
 * more.
 */
export function useExtensionsChannel(confirmInsecure: ConfirmInsecure) {
  const transport = useRef<StudioExtensionsTransport>('insecure');
  const acknowledged = useRef(false);
  /** Changes when the screen is left: secrets asked for before then are not sent. */
  const generation = useRef(0);
  const [current, setCurrent] = useState<StudioExtensionsTransport | undefined>(undefined);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

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

  /** One secret request: checked, asked about, and sent only while the screen that asked is open. */
  const deliverSecret = useCallback(
    async (command: StudioExtensionsRequest, asked: number): Promise<SendResult> => {
      const left = (): boolean => generation.current !== asked;
      await deliver({ action: 'get_settings' });
      if (left()) return 'declined';
      if (transport.current !== 'secure' && !(await acknowledge())) return 'declined';
      if (left()) return 'declined';
      return deliver(transport.current === 'secure' ? command : { ...command, acknowledgeInsecureTransport: true });
    },
    [acknowledge, deliver]
  );

  const send = useCallback(
    async (command: StudioExtensionsRequest, options: SendOptions = {}): Promise<SendResult> => {
      if (!options.secret) return deliver(command);
      const asked = generation.current;
      const reply = await deliverSecret(command, asked);
      if (reply === 'declined' || failureCode(reply) !== 'INSECURE_TRANSPORT') return reply;
      acknowledged.current = false;
      return deliverSecret(command, asked);
    },
    [deliver, deliverSecret]
  );

  return { send, transport: current };
}
