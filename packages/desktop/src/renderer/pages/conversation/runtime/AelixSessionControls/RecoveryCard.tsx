/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ProfileCatalogView,
  SessionProfiles,
  SessionSelections,
} from '@/renderer/services/runtime/NativeResources';
import { Button, Checkbox, Tooltip } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KEY, recoveryTitle, refLabel } from './labels';
import { restorePlan, withToolState, type RecoveryState, type RestoreChoice } from './useAelixSessionControls';

type RecoveryCardProps = {
  recovery: RecoveryState;
  profiles?: ProfileCatalogView<SessionProfiles>;
  tools?: SessionSelections;
  blocked: string | null;
  restoring: boolean;
  onRestore: (choice: RestoreChoice) => void;
  onClose: () => void;
};

function overrideLabel(t: (key: string, values?: Record<string, string>) => string, value: readonly string[] | null) {
  if (value === null) return t(`${KEY}.tools.inherited`);
  if (value.length === 0) return t(`${KEY}.tools.none`);
  return value.join(', ');
}

/**
 * Offer to bring back the environment from before a failed or refused change. Only items that
 * differ from the current effective values are listed, and only the ones the user ticks are
 * restored, each through its original path. Nothing widens permissions and no prompt is re-sent.
 */
const RecoveryCard: React.FC<RecoveryCardProps> = ({
  recovery,
  profiles,
  tools,
  blocked,
  restoring,
  onRestore,
  onClose,
}) => {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<RestoreChoice>({ profile: false, tools: false });
  const plan = withToolState(restorePlan(recovery, profiles), tools);
  const toolsViaProfile = plan.tools.reason === 'with-profile' && choice.profile && plan.profile.restorable;
  const picked = (choice.profile && plan.profile.restorable) || (choice.tools && plan.tools.restorable);
  const nothingDiffers = !plan.profile.differs && !plan.tools.differs;
  const original = plan.profile.ref;

  return (
    <div
      className='flex flex-col gap-8px rounded-8px border border-solid border-b-base bg-fill-1 p-10px'
      data-testid='aelix-recovery-card'
    >
      <div className='text-14px font-medium text-t-primary'>
        {recoveryTitle(t, recovery.failure.status, recovery.failure.reason)}
      </div>
      <div className='text-12px text-t-secondary'>{t(`${KEY}.recovery.noResend`)}</div>
      <div className='text-12px text-t-secondary' data-testid='aelix-recovery-original'>
        {t(`${KEY}.recovery.original`, { profile: refLabel(t, original) })}
      </div>
      {nothingDiffers && (
        <div className='text-12px text-t-primary' data-testid='aelix-recovery-unchanged'>
          {t(`${KEY}.recovery.unchanged`)}
        </div>
      )}
      {plan.profile.differs && (
        <div className='flex flex-col gap-2px'>
          <Checkbox
            checked={choice.profile}
            disabled={!plan.profile.restorable}
            onChange={(checked: boolean) => setChoice((previous) => ({ ...previous, profile: checked }))}
            data-testid='aelix-recovery-pick-profile'
          >
            {t(`${KEY}.recovery.restoreProfile`, { profile: refLabel(t, original) })}
          </Checkbox>
          {!plan.profile.restorable && (
            <div className='pl-24px text-12px text-t-secondary' data-testid='aelix-recovery-reopen'>
              {t(`${KEY}.recovery.${plan.profile.reason === 'unknown' ? 'unknownOriginal' : 'restoreFileAndReopen'}`)}
            </div>
          )}
        </div>
      )}
      {!plan.profile.differs && !plan.profile.offered && (
        <div className='text-12px text-t-secondary' data-testid='aelix-recovery-reopen'>
          {t(`${KEY}.recovery.restoreFileAndReopen`)}
        </div>
      )}
      {plan.tools.differs && plan.tools.before !== undefined && (
        <div className='flex flex-col gap-2px'>
          <Checkbox
            checked={choice.tools || toolsViaProfile}
            disabled={!plan.tools.restorable}
            onChange={(checked: boolean) => setChoice((previous) => ({ ...previous, tools: checked }))}
            data-testid='aelix-recovery-pick-tools'
          >
            {t(`${KEY}.recovery.restoreTools`, { tools: overrideLabel(t, plan.tools.before) })}
          </Checkbox>
          {plan.tools.reason === 'with-profile' && (
            <div className='pl-24px text-12px text-t-secondary'>{t(`${KEY}.recovery.toolsWithProfile`)}</div>
          )}
        </div>
      )}
      {choice.profile && plan.profile.restorable && plan.tools.before && !choice.tools && (
        <div className='text-12px text-warning'>{t(`${KEY}.recovery.profileResetsTools`)}</div>
      )}
      <div className='flex flex-wrap justify-end gap-8px'>
        <Button size='small' onClick={onClose} data-testid='aelix-recovery-close'>
          {t(`${KEY}.action.close`)}
        </Button>
        {!nothingDiffers && (
          <Tooltip content={blocked} disabled={!blocked}>
            <Button
              size='small'
              type='primary'
              loading={restoring}
              disabled={!picked || Boolean(blocked)}
              onClick={() => onRestore(choice)}
              data-testid='aelix-recovery-restore'
            >
              {t(`${KEY}.recovery.restoreSelected`)}
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

export default RecoveryCard;
