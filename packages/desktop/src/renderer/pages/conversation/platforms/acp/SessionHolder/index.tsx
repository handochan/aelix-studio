/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import SessionHolderBar from './SessionHolderBar';
import { useSessionHolder, type SessionHolderState } from './useSessionHolder';

type SessionHolderGateProps = {
  conversationId: string;
  /** Called after a recheck finds the session writable again. */
  onWritable?: () => void;
  /**
   * Renders the send box. `sendBlocked` is true until the first lock check confirms the
   * session is writable and stays true while it is held, so neither the user nor an
   * automatic send (stored first message, Draft Box queue) can reach a held session.
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
  const sendBoxRef = useRef<HTMLDivElement>(null);
  const previousStatusRef = useRef(status);

  // A successful recheck removes the focused recheck button; hand focus to the composer.
  useEffect(() => {
    if (previousStatusRef.current === 'held' && status === 'writable') {
      sendBoxRef.current?.querySelector('textarea')?.focus();
    }
    previousStatusRef.current = status;
  }, [status]);

  return (
    <>
      <span role='status' aria-live='polite' aria-atomic='true' className='sr-only' data-testid='session-holder-status'>
        {announcement}
      </span>
      {status === 'held' && holder && (
        <SessionHolderBar holder={holder} recheckState={recheckState} onRecheck={recheck} />
      )}
      {/* The send box stays mounted but hidden while held: unmounting it would hand its
          queued Draft Box items to the background runner, which sends without this gate. */}
      <div ref={sendBoxRef} className={status === 'held' ? 'hidden' : 'contents'} data-testid='session-holder-send-box'>
        {children(status !== 'writable')}
      </div>
    </>
  );
};

export default SessionHolderGate;
