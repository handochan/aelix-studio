/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { KEY } from './labels';
import type { AelixSessionControls, ControlsNotice } from './useAelixSessionControls';

/** Shared states before a control can be used: checking, not attached, update needed, sign-in, or read error. */
const AvailabilityNotice: React.FC<{ controls: AelixSessionControls }> = ({ controls }) => {
  const { t } = useTranslation();
  const { availability } = controls;
  switch (availability.kind) {
    case 'checking':
      return (
        <div className='flex items-center gap-8px text-t-secondary text-13px' data-testid='aelix-controls-checking'>
          <Spin size={14} />
          {t(`${KEY}.status.checking`)}
        </div>
      );
    case 'detached':
      return <Alert type='info' data-testid='aelix-controls-detached' content={t(`${KEY}.status.openFirst`)} />;
    case 'update-required':
      return <UpdateRequired />;
    case 'sign-in':
      return <Alert type='warning' data-testid='aelix-controls-sign-in' content={t(`${KEY}.status.signIn`)} />;
    case 'error':
      return (
        <Alert
          type='error'
          data-testid='aelix-controls-error'
          content={t(`${KEY}.status.readFailed`)}
          action={
            <Button size='mini' onClick={() => void controls.refresh()}>
              {t(`${KEY}.action.retry`)}
            </Button>
          }
        />
      );
    default:
      return null;
  }
};

export const UpdateRequired: React.FC<{ testId?: string }> = ({ testId = 'aelix-controls-update-required' }) => {
  const { t } = useTranslation();
  return (
    <Alert
      type='warning'
      data-testid={testId}
      title={t(`${KEY}.status.updateRequiredTitle`)}
      content={t(`${KEY}.status.updateRequired`)}
    />
  );
};

export const WriteNotice: React.FC<{ notice?: ControlsNotice; onClose: () => void }> = ({ notice, onClose }) => {
  const { t } = useTranslation();
  if (!notice) return null;
  return (
    <Alert
      type={notice.tone}
      closable
      onClose={onClose}
      data-testid='aelix-controls-notice'
      content={t(`${KEY}.notice.${notice.key}`, notice.values)}
    />
  );
};

/** Why a write button is disabled, or null when writing is allowed. */
export function writeBlockedText(
  t: (key: string) => string,
  controls: Pick<AelixSessionControls, 'writeBlocked' | 'writing'>
): string | null {
  if (controls.writing) return t(`${KEY}.status.writing`);
  if (controls.writeBlocked === 'busy') return t(`${KEY}.status.busy`);
  if (controls.writeBlocked === 'not-idle') return t(`${KEY}.status.notIdle`);
  return null;
}

export default AvailabilityNotice;
