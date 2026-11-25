/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Checkbox, Modal, Typography } from '@arco-design/web-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResourceChange } from '@/renderer/services/runtime/NativeResources';
import {
  changedSinceSave,
  compareRecovery,
  restorePlan,
  type RecoveryRecord,
  type RecoveryRowState,
} from './recoveryStore';
import type { Listing } from './useSelections';

type RecoveryModalProps = {
  visible: boolean;
  record: RecoveryRecord;
  listing: Listing;
  saving: boolean;
  onCancel: () => void;
  onRestore: (changes: ResourceChange[]) => void;
};

const STATE_KEYS: Record<Exclude<RecoveryRowState, 'restorable'>, string> = {
  restored: 'settings.aelixNative.recovery.alreadyRestored',
  missing: 'settings.aelixNative.recovery.unavailable',
  locked: 'settings.aelixNative.recovery.locked',
};

/**
 * Restore only the items the user picks, back to the scope they were saved in. Nothing is
 * preselected, so a change made elsewhere is never reverted without an explicit choice.
 */
const RecoveryModal: React.FC<RecoveryModalProps> = ({ visible, record, listing, saving, onCancel, onRestore }) => {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => compareRecovery(record, listing), [listing, record]);
  const changed = changedSinceSave(record, listing);
  const value = (on: boolean | null) =>
    on === null
      ? t('settings.aelixNative.unknownValue')
      : on
        ? t('settings.aelixNative.on')
        : t('settings.aelixNative.off');
  const explicitKey =
    record.target.scope === 'project'
      ? 'settings.aelixNative.recovery.explicitProject'
      : 'settings.aelixNative.recovery.explicitGlobal';

  useEffect(() => {
    if (visible) setPicked(new Set());
  }, [visible]);

  const toggle = (key: string, checked: boolean) => {
    setPicked((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  return (
    <Modal
      title={t('settings.aelixNative.recovery.title')}
      visible={visible}
      onCancel={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button
            type='primary'
            data-testid='aelix-recovery-restore'
            disabled={picked.size === 0}
            loading={saving}
            onClick={() =>
              onRestore(rows.filter((row) => picked.has(row.key)).map((row) => restorePlan(record.target, row).change))
            }
          >
            {t('settings.aelixNative.recovery.restore')}
          </Button>
        </>
      }
      unmountOnExit
    >
      <div className='flex flex-col gap-12px' data-testid='aelix-recovery-modal'>
        <Typography.Text className='text-13px text-t-secondary'>
          {t('settings.aelixNative.recovery.description')}
        </Typography.Text>
        {changed ? <Alert type='warning' content={t('settings.aelixNative.recovery.changedElsewhere')} /> : null}
        {record.uncertain ? <Alert type='info' content={t('settings.aelixNative.recovery.uncertain')} /> : null}
        {rows.length === 0 ? (
          <Typography.Text className='text-13px text-t-secondary'>
            {t('settings.aelixNative.recovery.none')}
          </Typography.Text>
        ) : (
          rows.map((row) => (
            <div
              key={row.key}
              data-testid={`aelix-recovery-row-${row.key}`}
              className='flex items-center justify-between gap-12px rd-8px bg-fill-1 px-12px py-8px'
            >
              <Checkbox
                checked={picked.has(row.key)}
                disabled={row.state !== 'restorable' || saving}
                onChange={(checked) => toggle(row.key, checked)}
              >
                <span className='text-13px text-t-primary'>{row.key}</span>
              </Checkbox>
              <div className='flex flex-col items-end text-12px text-t-secondary'>
                <span>{t('settings.aelixNative.recovery.previous', { value: value(row.before.on) })}</span>
                <span>{t('settings.aelixNative.recovery.current', { value: value(row.current) })}</span>
                {row.state === 'restorable' ? null : <span>{t(STATE_KEYS[row.state])}</span>}
                {row.state === 'restorable' && restorePlan(record.target, row).explicitWhereInherited ? (
                  <span data-testid={`aelix-recovery-explicit-${row.key}`}>{t(explicitKey)}</span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
};

export default RecoveryModal;
