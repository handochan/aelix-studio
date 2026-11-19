/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import SessionHolderBar, { useHolderNotice } from './SessionHolderBar';
import { useSessionHolder, type SessionHolderState } from './useSessionHolder';

type SessionHolderGateProps = {
  conversationId: string;
  /** Called after a recheck finds the session writable again. */
  onWritable?: () => void;
  /**
   * Renders the send box. `sendBlocked` stays true until a check confirms the session is
   * not locked, so neither the user nor an automatic send (stored first message, Draft
   * Box queue) can reach a session that is, or may be, held by another writer.
   */
  children: (sendBlocked: boolean) => React.ReactNode;
};

const isBlockedNotice = (status: SessionHolderState['status']) => status === 'held' || status === 'unconfirmed';

const useAnnouncement = ({ status, holder, recheckState, failure }: SessionHolderState): string => {
  const { t } = useTranslation();
  const notice = useHolderNotice(holder, failure);
  if (!isBlockedNotice(status) || recheckState === 'checking') return '';
  if (recheckState === 'stillHeld') return t('conversation.sessionHolder.stillHeld');
  const text = [`${notice.title}.`, notice.body, ...notice.hints].join(' ');
  return recheckState === 'failed' && holder ? `${text} ${t('conversation.sessionHolder.checkFailed')}` : text;
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
  const { status, holder, recheckState, failure, recheck } = state;
  const blocked = isBlockedNotice(status);
  const sendBoxRef = useRef<HTMLDivElement>(null);
  const previousStatusRef = useRef(status);

  // A successful recheck removes the focused recheck button; hand focus to the composer.
  useEffect(() => {
    if (isBlockedNotice(previousStatusRef.current) && status === 'writable') {
      sendBoxRef.current?.querySelector('textarea')?.focus();
    }
    previousStatusRef.current = status;
  }, [status]);

  return (
    <>
      <span role='status' aria-live='polite' aria-atomic='true' className='sr-only' data-testid='session-holder-status'>
        {announcement}
      </span>
      {blocked && (
        <SessionHolderBar holder={holder} recheckState={recheckState} failure={failure} onRecheck={recheck} />
      )}
      {/* The send box stays mounted but hidden while blocked; its Draft Box is held (see
          AcpSendBox `holdExecution`) and never detaches to the background runner. */}
      <div ref={sendBoxRef} className={blocked ? 'hidden' : 'contents'} data-testid='session-holder-send-box'>
        {children(status !== 'writable')}
      </div>
    </>
  );
};

export default SessionHolderGate;
