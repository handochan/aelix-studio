/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { WriteNotice, writeBlockedText } from './AvailabilityNotice';
import { KEY } from './labels';
import ProfileChangeCard from './ProfileChangeCard';
import RecoveryCard from './RecoveryCard';
import type { AelixSessionControls } from './useAelixSessionControls';

/** The in-flight write, its result, the decision-2 reselection card, and the recovery card. */
const WriteOutcome: React.FC<{ controls: AelixSessionControls }> = ({ controls }) => {
  const { t } = useTranslation();
  const blocked = writeBlockedText(t, controls);
  const { conflict, recovery } = controls;
  return (
    <>
      {controls.writing && (
        <div className='flex items-center gap-8px text-12px text-t-secondary' data-testid='aelix-controls-writing'>
          <Spin size={14} />
          {t(controls.writing === 'tools' ? `${KEY}.status.saving` : `${KEY}.status.applying`)}
        </div>
      )}
      <WriteNotice notice={controls.notice} onClose={controls.dismissNotice} />
      {conflict && (
        <ProfileChangeCard
          conflict={conflict}
          blocked={blocked}
          onReselect={() => void controls.reselect()}
          onKeepCurrent={controls.keepCurrent}
        />
      )}
      {recovery && (
        <RecoveryCard
          recovery={recovery}
          profiles={controls.profiles}
          tools={controls.tools}
          blocked={blocked}
          restoring={controls.writing === 'restore'}
          onRestore={(choice) => void controls.restore(choice)}
          onClose={controls.dismissRecovery}
        />
      )}
    </>
  );
};

export default WriteOutcome;
