/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { emitter } from '@/renderer/utils/emitter';
import { Button } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { AelixErrorAction as Action } from './aelixErrorGuidance';

/**
 * The next step on a builtin Aelix error card. It opens an existing surface (the
 * conversation's model picker or the model settings page) and never resends.
 */
const AelixErrorAction: React.FC<{ action: Action; conversationId?: string }> = ({ action, conversationId }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (action === 'choose_model') {
    // The picker belongs to one conversation; without its id there is nothing to open.
    if (!conversationId) return null;
    return (
      <Button size='small' type='primary' onClick={() => emitter.emit('acp.model.selector.open', conversationId)}>
        {t('conversation.agentError.actions.chooseModel')}
      </Button>
    );
  }

  return (
    <Button size='small' type='primary' onClick={() => void navigate('/settings/model')}>
      {t('conversation.agentError.actions.openModelSettings')}
    </Button>
  );
};

export default AelixErrorAction;
