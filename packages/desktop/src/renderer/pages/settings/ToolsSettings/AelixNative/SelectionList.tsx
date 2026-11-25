/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Spin, Switch, Tag, Tooltip, Typography } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResourceKind, ResourceRow } from '@/renderer/services/runtime/NativeResources';
import { diagnosticLabel, failureLabel, lockReasonLabel, scopeReasonLabel, type Label } from './labels';
import RecoveryModal from './RecoveryModal';
import { scopeStatus, useSelections, type Listing, type SelectionTarget, type SaveNotice } from './useSelections';

type SelectionListProps = {
  target: SelectionTarget;
  kind: ResourceKind;
  /** Re-run conversation discovery after a detached or replaced binding. */
  onRediscover?: () => void;
};

const P = 'settings.aelixNative';

function effectiveText(row: ResourceRow, t: (key: string) => string): string[] {
  const parts: string[] = [];
  if (row.loaded === false) parts.push(t(`${P}.state.notLoaded`));
  if (row.applied !== null) parts.push(t(row.applied ? `${P}.state.applied` : `${P}.state.notApplied`));
  if (row.inForce !== null) parts.push(t(row.inForce ? `${P}.state.inForce` : `${P}.state.notInForce`));
  if (row.live === null) parts.push(t(`${P}.state.liveUnknown`));
  else parts.push(t(row.live ? `${P}.state.live` : `${P}.state.notLive`));
  return parts;
}

const SelectionList: React.FC<SelectionListProps> = ({ target, kind, onRediscover }) => {
  const { t } = useTranslation();
  const state = useSelections(target, kind);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const { listing, failure, loading, saving, draft, notice, recovery, writable } = state;
  const label = ({ key, values }: Label) => t(key, values);
  const onOff = (on: boolean | null | undefined) =>
    on === true ? t(`${P}.on`) : on === false ? t(`${P}.off`) : t(`${P}.retry.missing`);
  const pendingLabel = (listingEffect: Listing['effect']) =>
    listingEffect === 'restart' || kind === 'mcp' ? t(`${P}.state.pendingRestart`) : t(`${P}.state.pendingNextRequest`);

  const renderNotice = (current: SaveNotice) => {
    if (current.type === 'saved') {
      return (
        <Alert
          type={current.message === 'notApplied' ? 'warning' : 'success'}
          data-testid='aelix-save-notice'
          content={[current.restored ? t(`${P}.recovery.restored`) : null, t(`${P}.saved.${current.message}`)]
            .filter(Boolean)
            .join(' ')}
          closable
          onClose={state.dismissNotice}
        />
      );
    }
    if (current.type === 'failure') {
      return (
        <Alert
          type='error'
          data-testid='aelix-save-failure'
          content={label(failureLabel(current.failure))}
          closable
          onClose={state.dismissNotice}
        />
      );
    }
    return (
      <Alert
        type='warning'
        data-testid={`aelix-retry-${current.reason}`}
        content={
          <div className='flex flex-col gap-8px'>
            <span>{t(`${P}.retry.${current.reason}`)}</span>
            {current.changes.map((change) => {
              const row = listing?.items.find((item) => item.key === change.key);
              return (
                <div key={change.key} data-testid={`aelix-retry-row-${change.key}`} className='text-12px'>
                  <span className='font-medium text-t-primary'>{change.key}</span>
                  <span className='ms-8px'>{t(`${P}.retry.current`, { value: onOff(row?.saved) })}</span>
                  <span className='ms-8px'>{t(`${P}.retry.choice`, { value: onOff(change.on) })}</span>
                </div>
              );
            })}
            <div className='flex gap-8px'>
              <Button
                size='mini'
                type='primary'
                data-testid='aelix-reapply'
                loading={saving}
                disabled={!listing || !writable}
                onClick={() => void state.reapply(current.changes)}
              >
                {t(`${P}.retry.reapply`)}
              </Button>
              <Button size='mini' onClick={state.dismissNotice}>
                {t(`${P}.retry.dismiss`)}
              </Button>
            </div>
          </div>
        }
      />
    );
  };

  if (!listing) {
    if (failure) {
      const rediscover = target.scope === 'project' && (failure.status === 'detached' || failure.status === 'stale');
      return (
        <Alert
          type={failure.status === 'unsupported' ? 'info' : 'warning'}
          data-testid='aelix-list-failure'
          content={
            <div className='flex flex-wrap items-center gap-8px'>
              <span>{label(failureLabel(failure))}</span>
              {failure.status === 'unsupported' ? null : (
                <Button size='mini' onClick={() => (rediscover && onRediscover ? onRediscover() : void state.reload())}>
                  {t(`${P}.reload`)}
                </Button>
              )}
            </div>
          }
        />
      );
    }
    return (
      <div className='flex justify-center py-16px'>
        <Spin loading={loading || !failure} tip={t(`${P}.loading`)} />
      </div>
    );
  }

  const scope = scopeStatus(listing);
  const unkeyed = listing.mismatches.filter((issue) => issue.key === null);

  return (
    <div className='flex flex-col gap-12px' data-testid={`aelix-selections-${kind}`}>
      {!scope.writable ? (
        <Alert type='info' data-testid='aelix-scope-readonly' content={label(scopeReasonLabel(scope.reason))} />
      ) : target.scope === 'project' && !target.canWrite ? (
        <Alert type='info' data-testid='aelix-scope-readonly' content={label(scopeReasonLabel('unsupported'))} />
      ) : !scope.exists ? (
        <Alert type='info' content={t(`${P}.missingStore`)} />
      ) : null}
      {listing.source === 'global' ? (
        <Typography.Text className='text-12px text-t-secondary' data-testid='aelix-effective-unknown'>
          {t(`${P}.effectiveUnknown`)}
        </Typography.Text>
      ) : listing.policyPending ? (
        <Tag color='gold'>{t(`${P}.state.policyPending`)}</Tag>
      ) : null}
      {!listing.complete ? <Alert type='info' content={t(`${P}.partial`)} /> : null}
      {listing.diagnostics.length > 0 ? (
        <Alert
          type='warning'
          data-testid='aelix-diagnostics'
          title={t(`${P}.diagnostics.title`)}
          content={
            <ul className='m-0 ps-16px'>
              {listing.diagnostics.map((entry) => (
                <li key={`${entry.code}:${entry.key ?? ''}:${entry.source ?? ''}`}>
                  {label(diagnosticLabel(entry.code))}
                  {entry.key || entry.source ? ` · ${[entry.key, entry.source].filter(Boolean).join(' · ')}` : ''}
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
      {unkeyed.length > 0 ? <Alert type='warning' content={t(`${P}.mismatchList`)} /> : null}
      {notice ? renderNotice(notice) : null}

      {listing.items.length === 0 ? (
        <div className='py-16px text-center text-13px text-t-secondary'>{t(`${P}.empty`)}</div>
      ) : (
        <div className='flex flex-col gap-6px'>
          {listing.items.map((row) => {
            const staged = draft.get(row.key);
            const checked = staged ?? row.saved === true;
            const editable = writable && row.role === 'item' && row.lock === null && row.saved !== null && !saving;
            return (
              <div
                key={row.key}
                data-testid={`aelix-row-${row.key}`}
                className='flex items-center justify-between gap-12px rd-8px bg-base px-12px py-8px'
              >
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-6px'>
                    <Typography.Text className='text-13px text-t-primary'>{row.label}</Typography.Text>
                    {row.decidedBy ? <Tag size='small'>{t(`${P}.decidedBy.${row.decidedBy}`)}</Tag> : null}
                    {row.lock ? (
                      <Tag size='small' color='orange' data-testid={`aelix-lock-${row.key}`}>
                        {t(`${P}.lock.title`, {
                          value: onOff(row.lock.value),
                          reason: label(lockReasonLabel(row.lock.reason)),
                        })}
                      </Tag>
                    ) : null}
                    {row.problem ? (
                      <Tag size='small' color='red'>
                        {t(`${P}.problem`, { code: row.problem })}
                      </Tag>
                    ) : null}
                    {row.mismatches.length > 0 ? (
                      <Tooltip content={row.mismatches.map((issue) => issue.reason).join(', ')}>
                        <Tag size='small' color='gold' data-testid={`aelix-mismatch-${row.key}`}>
                          {t(`${P}.mismatch`)}
                        </Tag>
                      </Tooltip>
                    ) : null}
                    {row.pending ? (
                      <Tag size='small' color='arcoblue' data-testid={`aelix-pending-${row.key}`}>
                        {pendingLabel(listing.effect)}
                      </Tag>
                    ) : null}
                    {staged !== undefined ? (
                      <Tag size='small' color='purple'>
                        {t(`${P}.unsaved`)}
                      </Tag>
                    ) : null}
                  </div>
                  {listing.source === 'session' && row.role === 'item' ? (
                    <div className='mt-2px text-12px text-t-secondary' data-testid={`aelix-effective-${row.key}`}>
                      {effectiveText(row, t).join(' · ')}
                    </div>
                  ) : null}
                </div>
                {row.role === 'item' ? (
                  <Switch
                    size='small'
                    aria-label={row.label}
                    data-testid={`aelix-switch-${row.key}`}
                    checked={checked}
                    disabled={!editable}
                    onChange={(on) => state.toggle(row.key, on)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className='flex flex-wrap items-center justify-end gap-8px'>
        {recovery ? (
          <Button size='small' data-testid='aelix-recovery-open' onClick={() => setRecoveryOpen(true)}>
            {t(`${P}.recovery.open`)}
          </Button>
        ) : null}
        <Button size='small' disabled={loading || saving} onClick={() => void state.reload()}>
          {t(`${P}.reload`)}
        </Button>
        {draft.size > 0 ? (
          <>
            <Button size='small' disabled={saving} onClick={state.discard}>
              {t(`${P}.discard`)}
            </Button>
            <Button
              size='small'
              type='primary'
              data-testid='aelix-save'
              loading={saving}
              disabled={!writable}
              onClick={() => void state.save()}
            >
              {t(`${P}.save`)}
            </Button>
          </>
        ) : null}
      </div>

      {recovery ? (
        <RecoveryModal
          visible={recoveryOpen}
          record={recovery}
          listing={listing}
          saving={saving}
          onCancel={() => setRecoveryOpen(false)}
          onRestore={(changes) => {
            setRecoveryOpen(false);
            void state.restore(changes);
          }}
        />
      ) : null}
    </div>
  );
};

export default SelectionList;
