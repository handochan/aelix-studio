/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SessionHolderBar from './SessionHolderBar';
import { useSessionHolder } from './useSessionHolder';

type SessionHolderGateProps = {
  conversationId: string;
  /** Called after a recheck finds the session writable again. */
  onWritable?: () => void;
  /** The send box; replaced by a read-only notice while another writer holds the session. */
  children: React.ReactNode;
};

/**
 * Self-contained Aelix holder module (D20): shows who holds the native session and
 * keeps the conversation read-only until the holder releases it. It reads only host
 * lock reports and does not touch the conversation message store.
 */
const SessionHolderGate: React.FC<SessionHolderGateProps> = ({ conversationId, onWritable, children }) => {
  const { holder, checking, stillHeld, recheck } = useSessionHolder(conversationId, onWritable);
  if (!holder) return <>{children}</>;
  return <SessionHolderBar holder={holder} checking={checking} stillHeld={stillHeld} onRecheck={recheck} />;
};

export default SessionHolderGate;
