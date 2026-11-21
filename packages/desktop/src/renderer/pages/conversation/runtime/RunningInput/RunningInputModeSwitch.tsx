/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Radio, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RunningInputMode } from '@/renderer/services/runtime/RunningInput';

export const RUNNING_INPUT_MODE_KEY = { steer: 'steer', 'follow-up': 'followUp' } as const;

type RunningInputModeSwitchProps = {
  modes: readonly RunningInputMode[];
  value: RunningInputMode;
  onChange: (mode: RunningInputMode) => void;
};

/** Chooses how the next send reaches the running turn. Only advertised modes are offered. */
const RunningInputModeSwitch: React.FC<RunningInputModeSwitchProps> = ({ modes, value, onChange }) => {
  const { t } = useTranslation();
  return (
    <Radio.Group
      type='button'
      size='mini'
      className='shrink-0'
      value={modes.includes(value) ? value : modes[0]}
      onChange={(next: RunningInputMode) => onChange(next)}
      aria-label={t('acp.runningInput.mode.label')}
      data-testid='running-input-mode'
    >
      {modes.map((mode) => {
        const key = RUNNING_INPUT_MODE_KEY[mode];
        return (
          <Radio key={mode} value={mode}>
            <Tooltip content={t(`acp.runningInput.mode.${key}Hint`)} position='top'>
              <span>{t(`acp.runningInput.mode.${key}`)}</span>
            </Tooltip>
          </Radio>
        );
      })}
    </Radio.Group>
  );
};

export default RunningInputModeSwitch;
