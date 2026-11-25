/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResourceFailure } from '@/renderer/services/runtime/NativeResources';
import { Alert, Button, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { differenceField, differenceValue, KEY, refLabel } from './labels';

type ProfileChangeCardProps = {
  conflict: ResourceFailure;
  /** Why reselecting is not possible right now, or null. */
  blocked: string | null;
  onReselect: () => void;
  onKeepCurrent: () => void;
};

/**
 * Decision 2: the profile the user picked changed its source or revision before it was applied.
 * Show what differs and let the user reselect the current candidate once. The runtime then asks
 * for the single standard approval in the conversation. Keeping the current environment leads
 * to the recovery card instead.
 */
const ProfileChangeCard: React.FC<ProfileChangeCardProps> = ({ conflict, blocked, onReselect, onKeepCurrent }) => {
  const { t } = useTranslation();
  const differences = conflict.differences ?? [];
  const candidate = conflict.candidate ?? null;
  return (
    <div
      className='flex flex-col gap-8px rounded-8px border border-solid border-warning p-10px'
      data-testid='aelix-profile-change-card'
    >
      <div className='text-14px font-medium text-t-primary'>{t(`${KEY}.change.title`)}</div>
      <div className='text-12px text-t-secondary'>{t(`${KEY}.change.description`)}</div>
      <dl className='m-0 grid grid-cols-[auto_1fr] gap-x-8px gap-y-2px text-12px'>
        <dt className='text-t-secondary'>{t(`${KEY}.change.recorded`)}</dt>
        <dd className='m-0 text-t-primary break-all' data-testid='aelix-change-recorded'>
          {refLabel(t, conflict.recorded ?? null)}
        </dd>
        <dt className='text-t-secondary'>{t(`${KEY}.change.candidate`)}</dt>
        <dd className='m-0 text-t-primary break-all' data-testid='aelix-change-candidate'>
          {candidate ? refLabel(t, candidate) : t(`${KEY}.change.missing`)}
        </dd>
      </dl>
      {differences.length > 0 && (
        <table className='w-full border-collapse text-12px' data-testid='aelix-change-differences'>
          <thead>
            <tr className='text-left text-t-secondary'>
              <th className='font-normal pr-8px'>{t(`${KEY}.change.field`)}</th>
              <th className='font-normal pr-8px'>{t(`${KEY}.change.before`)}</th>
              <th className='font-normal'>{t(`${KEY}.change.after`)}</th>
            </tr>
          </thead>
          <tbody>
            {differences.map((difference) => (
              <tr key={difference.field} className='align-top text-t-primary'>
                <td className='pr-8px text-t-secondary'>{differenceField(t, difference.field)}</td>
                <td className='pr-8px break-all'>{differenceValue(t, difference.field, difference.before)}</td>
                <td className='break-all'>{differenceValue(t, difference.field, difference.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!candidate && <Alert type='warning' content={t(`${KEY}.change.noCandidate`)} />}
      <div className='flex flex-wrap justify-end gap-8px'>
        <Button size='small' onClick={onKeepCurrent} data-testid='aelix-change-keep'>
          {t(`${KEY}.change.keep`)}
        </Button>
        {candidate && (
          <Tooltip content={blocked} disabled={!blocked}>
            <Button
              size='small'
              type='primary'
              disabled={Boolean(blocked)}
              onClick={onReselect}
              data-testid='aelix-change-reselect'
            >
              {t(`${KEY}.change.reselect`)}
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

export default ProfileChangeCard;
