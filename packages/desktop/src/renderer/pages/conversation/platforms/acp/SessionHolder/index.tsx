/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import SessionHolderBar from './SessionHolderBar';
import { useSessionHolder, type SessionHolderState } from './useSessionHolder';

type SessionHolderGateProps = {
  conversationId: string;
  /** Called after a recheck finds the session writable again. */
  onWritable?: () => void;
  /**
   * Renders the send box. `sendBlocked` stays true until the first lock check settles,
   * so neither the user nor an automatic first message can send before the holder is known.
   */
  children: (sendBlocked: boolean) => React.ReactNode;
};

const useAnnouncement = ({ status, holder, recheckState }: SessionHolderState): string => {
  const { t } = useTranslation();
  if (status !== 'held' || !holder || recheckState === 'checking') return '';
  if (recheckState === 'failed') return t('conversation.sessionHolder.checkFailed');
  if (recheckState === 'stillHeld') return t('conversation.sessionHolder.stillHeld');
  return `${t(`conversation.sessionHolder.${holder.kind}.title`)}. ${t(`conversation.sessionHolder.${holder.kind}.body`)}`;
};

/**
 * Self-contained Aelix holder module (D20): shows who holds the native session and
 * keeps the conversation read-only until the holder releases it. It reads only host
 * lock reports and does not touch the conversation message store.
 *
 * The status region is mounted before any result so assistive technology announces
 * the lock when the send box is replaced, and each recheck outcome after it.
 */
const SessionHolderGate: React.FC<SessionHolderGateProps> = ({ conversationId, onWritable, children }) => {
  const state = useSessionHolder(conversationId, onWritable);
  const announcement = useAnnouncement(state);
  const { status, holder, recheckState, recheck } = state;

  return (
    <>
      <span role='status' aria-live='polite' aria-atomic='true' className='sr-only' data-testid='session-holder-status'>
        {announcement}
      </span>
      {status === 'held' && holder ? (
        <SessionHolderBar holder={holder} recheckState={recheckState} onRecheck={recheck} />
      ) : (
        children(status === 'checking')
      )}
    </>
  );
};

export default SessionHolderGate;
