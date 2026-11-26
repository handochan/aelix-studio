/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { openModelPicker, useCanOpenModelPicker } from '@/renderer/hooks/agent/useModelPickerOpener';
import { Button } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { AelixErrorActionKind } from './aelixErrorGuidance';

/**
 * The next step on a builtin Aelix error card. It opens an existing surface (the
 * conversation's model picker or the model settings page) and never resends.
 */
const AelixErrorAction: React.FC<{ action: AelixErrorActionKind; conversationId?: string }> = ({
  action,
  conversationId,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canChooseModel = useCanOpenModelPicker(action === 'choose_model' ? conversationId : undefined);

  if (action === 'choose_model') {
    // The picker belongs to one conversation; without its id there is nothing to open.
    if (!conversationId) return null;
    // Disabled while no picker of this conversation can switch models (still loading, restarting).
    return (
      <Button
        size='small'
        type='primary'
        disabled={!canChooseModel}
        onClick={() => void openModelPicker(conversationId)}
      >
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
