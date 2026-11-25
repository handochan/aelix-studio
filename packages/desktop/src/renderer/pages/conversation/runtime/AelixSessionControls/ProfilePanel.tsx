/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProfilePreview } from '@/renderer/services/runtime/NativeResources';
import { Alert, Button, Radio, Spin, Tag, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import AvailabilityNotice, { UpdateRequired, writeBlockedText } from './AvailabilityNotice';
import { KEY, refLabel, sameRef, scopeLabel, shortRevision, toolRestriction } from './labels';
import type { AelixSessionControls } from './useAelixSessionControls';
import WriteOutcome from './WriteOutcome';

const PreviewDetails: React.FC<{ preview: ProfilePreview }> = ({ preview }) => {
  const { t } = useTranslation();
  const rows: Array<[string, string]> = [
    [t(`${KEY}.preview.source`), preview.source],
    [t(`${KEY}.preview.revision`), shortRevision(preview.ref.revision)],
    [t(`${KEY}.preview.tools`), toolRestriction(t, preview.tools)],
    [
      t(`${KEY}.preview.skills`),
      preview.skills === null
        ? t(`${KEY}.preview.allSkills`)
        : preview.skills.join(', ') || t(`${KEY}.preview.noSkills`),
    ],
    [t(`${KEY}.preview.model`), preview.model ?? t(`${KEY}.preview.inheritModel`)],
    [t(`${KEY}.preview.approval`), preview.approvalMode],
  ];
  if (preview.policy.excludeTools.length > 0) {
    rows.push([t(`${KEY}.preview.excludedTools`), preview.policy.excludeTools.join(', ')]);
  }
  return (
    <div className='flex flex-col gap-6px rounded-8px bg-fill-1 p-10px' data-testid='aelix-profile-preview'>
      {preview.description && <div className='text-13px text-t-primary'>{preview.description}</div>}
      <dl className='m-0 grid grid-cols-[auto_1fr] gap-x-8px gap-y-2px text-12px'>
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className='text-t-secondary'>{label}</dt>
            <dd className='m-0 text-t-primary break-all'>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {preview.promptPreview && (
        <div className='text-12px text-t-secondary whitespace-pre-wrap break-words max-h-96px overflow-auto'>
          {preview.promptPreview}
          {preview.promptTruncated && <span className='text-t-tertiary'> {t(`${KEY}.preview.truncated`)}</span>}
        </div>
      )}
    </div>
  );
};

/** Profile picker for one open builtin Aelix conversation: preview, apply while idle, and recover. */
const ProfilePanel: React.FC<{ controls: AelixSessionControls }> = ({ controls }) => {
  const { t } = useTranslation();
  const { availability, profiles, preview, previewName } = controls;
  const blocked = writeBlockedText(t, controls);

  if (availability.kind !== 'ready') return <AvailabilityNotice controls={controls} />;
  const { capabilities } = availability;
  if (!capabilities.profilesList) return <UpdateRequired />;

  const active = profiles?.activeRef ?? null;
  const legacyName = !active && profiles?.activeAgent ? profiles.activeAgent : null;
  // Only a runtime without `profiles/use` lacks selection. Until the native guard ships, ACP applies
  // by name with a revision check and reports drift through the same decision-2 flow.
  const canApply = capabilities.profilesUse;
  const selected = preview && previewName === preview.ref.name ? preview : undefined;

  return (
    <div className='flex flex-col gap-10px' data-testid='aelix-profile-panel'>
      <div className='text-12px text-t-secondary' data-testid='aelix-profile-current'>
        {legacyName
          ? t(`${KEY}.profile.currentLegacy`, { name: legacyName })
          : t(`${KEY}.profile.current`, { profile: refLabel(t, active) })}
      </div>
      <WriteOutcome controls={controls} />
      {!canApply && <UpdateRequired testId='aelix-profile-apply-update-required' />}
      {controls.profilesFailure && <Alert type='error' content={t(`${KEY}.status.readFailed`)} />}
      {profiles && profiles.profiles.length === 0 && (
        <div className='text-12px text-t-secondary'>{t(`${KEY}.profile.empty`)}</div>
      )}
      {profiles && profiles.profiles.length > 0 && (
        <Radio.Group
          direction='vertical'
          value={previewName ?? undefined}
          onChange={(name: string) => void controls.inspect(name)}
          className='flex flex-col gap-4px'
          data-testid='aelix-profile-list'
        >
          {profiles.profiles.map(({ ref, description }) => (
            <Radio key={ref.name} value={ref.name} disabled={!capabilities.profilesShow}>
              <span className='inline-flex flex-col min-w-0'>
                <span className='inline-flex items-center gap-6px text-13px text-t-primary'>
                  {ref.name}
                  <Tag size='small'>{scopeLabel(t, ref.scope)}</Tag>
                  {sameRef(ref, active) && (
                    <Tag size='small' color='green'>
                      {t(`${KEY}.profile.active`)}
                    </Tag>
                  )}
                </span>
                {description && <span className='text-12px text-t-secondary'>{description}</span>}
              </span>
            </Radio>
          ))}
        </Radio.Group>
      )}
      {profiles && !profiles.complete && <Alert type='warning' content={t(`${KEY}.profile.partial`)} />}
      {profiles && profiles.diagnostics.length > 0 && (
        <Alert
          type='warning'
          data-testid='aelix-profile-diagnostics'
          content={t(`${KEY}.profile.diagnostics`, {
            codes: profiles.diagnostics.map(({ code, key }) => (key ? `${key}: ${code}` : code)).join(', '),
          })}
        />
      )}
      {previewName && !selected && !controls.previewFailure && <Spin size={14} />}
      {controls.previewFailure && <Alert type='error' content={t(`${KEY}.preview.failed`)} />}
      {selected && <PreviewDetails preview={selected} />}
      {canApply && (
        <div className='flex flex-wrap justify-end gap-8px'>
          {(active || legacyName) && (
            <Tooltip content={blocked} disabled={!blocked}>
              <Button
                size='small'
                disabled={Boolean(blocked)}
                onClick={() => void controls.applyProfile(null)}
                data-testid='aelix-profile-clear'
              >
                {t(`${KEY}.profile.clear`)}
              </Button>
            </Tooltip>
          )}
          <Tooltip content={blocked} disabled={!blocked || !selected}>
            <Button
              size='small'
              type='primary'
              loading={controls.writing === 'profile'}
              disabled={!selected || Boolean(blocked) || sameRef(selected.ref, active)}
              onClick={() => selected && void controls.applyProfile(selected.ref)}
              data-testid='aelix-profile-apply'
            >
              {t(`${KEY}.profile.apply`)}
            </Button>
          </Tooltip>
        </div>
      )}
      {canApply && controls.tools && controls.tools.toolOverride !== null && (
        <div className='text-12px text-warning' data-testid='aelix-profile-resets-tools'>
          {t(`${KEY}.profile.resetsTools`)}
        </div>
      )}
      {canApply && blocked && !controls.writing && (
        <div className='text-12px text-t-secondary' data-testid='aelix-controls-blocked'>
          {blocked}
        </div>
      )}
    </div>
  );
};

export default ProfilePanel;
