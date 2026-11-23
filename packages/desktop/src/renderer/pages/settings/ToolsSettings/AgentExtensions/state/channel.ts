/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StudioExtensionsReply, StudioExtensionsRequest, StudioExtensionsTransport } from '@aionui/web-host';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestStudioExtensions } from '../client';
import { carriesSecret } from './secrets';

/** Asks the user whether a secret may cross the network unencrypted; resolves true to go on. */
export type ConfirmInsecure = () => Promise<boolean>;

/**
 * Whether the flow a request belongs to may still send: the same owner and sign-in, the same
 * visit of the screen, and no newer request in its place. Captured when the flow starts, before
 * anything it awaits (a dialog, a check), and asked again after every await.
 */
export type StillValid = () => boolean;

const always: StillValid = () => true;

/**
 * What `send` gives back: the reply, or `declined` when the user kept a secret from an insecure
 * channel, or the flow it was sent for was no longer valid before it went out.
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
 * `send` decides from the request itself whether it carries a secret (`carriesSecret`); a
 * request that does goes out only through `deliverSecret`, one at a time:
 * 1. the flow must still be valid (checked again after every await below);
 * 2. the transport is read with a request that carries nothing (`get_settings`), and only that
 *    reply's transport decides;
 * 3. over an insecure channel the user is asked, once for this visit while the channel stays
 *    insecure (any secure reply takes the yes back; no reply gives one); after a yes the
 *    request carries `acknowledgeInsecureTransport: true`;
 * 4. a request the host still refuses as `INSECURE_TRANSPORT` is asked about again, even for a
 *    verdict already confirmed, and goes the same way once more.
 * Any other request goes out at once, if its flow is still valid.
 */
export function useExtensionsChannel(confirmInsecure: ConfirmInsecure) {
  /** The user said yes to sending secrets over the insecure channel the checks found. */
  const acknowledged = useRef(false);
  /** Changes when the screen is left: nothing asked for before then is sent. */
  const generation = useRef(0);
  /** Secret requests, one after another: no two checks or questions at once. */
  const secrets = useRef<Promise<unknown>>(Promise.resolve());
  const [banner, setBanner] = useState<StudioExtensionsTransport | undefined>(undefined);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const deliver = useCallback(async (request: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
    const reply = await requestStudioExtensions(request);
    const transport = reply.transport ?? 'insecure';
    // Any reply may take back a yes (the channel changed since), never give one.
    if (transport === 'secure') acknowledged.current = false;
    setBanner(transport);
    return reply;
  }, []);

  /** One secret request, checked, asked about, and sent only while its flow is valid. */
  const deliverSecret = useCallback(
    async (command: StudioExtensionsRequest, valid: StillValid, visit: number): Promise<SendResult> => {
      const ok = (): boolean => generation.current === visit && valid();
      const attempt = async (): Promise<SendResult> => {
        if (!ok()) return 'declined';
        const check = await deliver({ action: 'get_settings' });
        // This check's own answer decides, not whichever reply came last.
        const verdict = check.transport ?? 'insecure';
        if (!ok()) return 'declined';
        if (verdict !== 'secure' && !acknowledged.current) {
          const yes = await confirmInsecure();
          if (!ok() || !yes) return 'declined';
          acknowledged.current = true;
        }
        if (!ok()) return 'declined';
        return deliver(verdict === 'secure' ? command : { ...command, acknowledgeInsecureTransport: true });
      };
      const reply = await attempt();
      if (reply === 'declined' || failureCode(reply) !== 'INSECURE_TRANSPORT') return reply;
      acknowledged.current = false;
      return attempt();
    },
    [confirmInsecure, deliver]
  );

  const send = useCallback(
    async (command: StudioExtensionsRequest, valid: StillValid = always): Promise<SendResult> => {
      const visit = generation.current;
      if (!valid()) return 'declined';
      if (!carriesSecret(command)) return deliver(command);
      const turn = secrets.current.then(() => deliverSecret(command, valid, visit));
      secrets.current = turn.catch((): void => {});
      return turn;
    },
    [deliver, deliverSecret]
  );

  return { send, transport: banner };
}
