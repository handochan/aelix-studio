/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionOperation } from '@aionui/web-host';
import { Alert, Button, Collapse, Modal, Steps } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { failureKey } from '../messages';
import { isFinished } from '../state/operation';

/** The stages a change goes through, in order; progress shows the stage only (no R8, A10). */
const STAGES = ['checking', 'preparing', 'installing', 'verifying', 'switched'] as const;

type Props = {
  operation?: ExtensionOperation;
  /** What can follow a failure (ask again, reconcile, …), shown once the change has ended. */
  followUps?: React.ReactNode;
  onCancel: () => void;
  onClose: () => void;
};

/**
 * A running change and how it ended: the stages, a cancel button while it runs, and on failure
 * the text for its code with the end of the installer output folded away.
 */
const OperationView: React.FC<Props> = ({ operation, followUps, onCancel, onClose }) => {
  const { t } = useTranslation();
  if (!operation) return null;
  const finished = isFinished(operation);
  const { phase } = operation;
  const succeeded = phase === 'switched' || phase === 'already_latest';
  // Arco counts steps from 1: the stage in progress, or one past the last when all are done.
  const step = succeeded ? STAGES.length + 1 : STAGES.indexOf(operation.phase as (typeof STAGES)[number]) + 1;
  return (
    <Modal
      visible
      title={t(`settings.agentExtensions.progress.title.${operation.action}`)}
      closable={finished}
      maskClosable={false}
      onCancel={finished ? onClose : undefined}
      footer={
        finished ? (
          <>
            {followUps}
            <Button type='primary' onClick={onClose} data-testid='operation-close'>
              {t('settings.agentExtensions.actions.close')}
            </Button>
          </>
        ) : (
          <Button onClick={onCancel} data-testid='operation-cancel'>
            {t('settings.agentExtensions.progress.cancel')}
          </Button>
        )
      }
    >
      <div className='flex flex-col gap-16px' data-testid='operation-view'>
        {(!finished || succeeded) && (
          <Steps size='small' current={Math.max(step, 1)} data-testid='operation-steps'>
            {STAGES.map((stage) => (
              <Steps.Step key={stage} title={t(`settings.agentExtensions.progress.phases.${stage}`)} />
            ))}
          </Steps>
        )}
        {operation.phase === 'switched' && (
          <Alert type='success' content={t('settings.agentExtensions.progress.switched')} />
        )}
        {phase === 'already_latest' && (
          <Alert type='info' content={t('settings.agentExtensions.progress.alreadyLatest')} />
        )}
        {operation.phase === 'cancelled' && (
          <Alert type='info' content={t('settings.agentExtensions.progress.cancelled')} />
        )}
        {operation.phase === 'failed' && (
          <Alert type='error' content={t(failureKey(operation.code))} data-testid='operation-failure' />
        )}
        {finished && operation.output && (
          <Collapse bordered={false}>
            <Collapse.Item name='output' header={t('settings.agentExtensions.progress.output')}>
              <pre className='m-0 max-h-240px overflow-auto whitespace-pre-wrap break-all text-12px text-t-secondary'>
                {operation.output}
              </pre>
            </Collapse.Item>
          </Collapse>
        )}
      </div>
    </Modal>
  );
};

export default OperationView;
