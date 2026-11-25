/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResourceRow, SessionSelections } from '@/renderer/services/runtime/NativeResources';
import { Alert, Button, Checkbox, Tag, Tooltip } from '@arco-design/web-react';
import { Lock } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AvailabilityNotice, { UpdateRequired, writeBlockedText } from './AvailabilityNotice';
import { KEY, lockReason } from './labels';
import type { AelixSessionControls } from './useAelixSessionControls';
import WriteOutcome from './WriteOutcome';

type Translate = (key: string, values?: Record<string, string>) => string;

function flag(t: Translate, value: boolean | null): string {
  if (value === null) return t(`${KEY}.row.unobserved`);
  return t(value ? `${KEY}.row.on` : `${KEY}.row.off`);
}

/** Saved, applied and live values side by side, as native reports them. */
const RowState: React.FC<{ row: ResourceRow; effect: SessionSelections['effect'] }> = ({ row, effect }) => {
  const { t } = useTranslation();
  return (
    <div
      className='flex flex-wrap items-center gap-4px text-11px text-t-secondary'
      data-testid={`aelix-tool-state-${row.key}`}
    >
      <span>
        {t(`${KEY}.row.saved`, { value: flag(t, row.saved) })}
        {row.decidedBy && ` (${t(`${KEY}.row.decidedBy.${row.decidedBy}`)})`}
      </span>
      <span>· {t(`${KEY}.row.applied`, { value: flag(t, row.inForce ?? row.applied) })}</span>
      <span>· {t(`${KEY}.row.live`, { value: flag(t, row.live) })}</span>
      {row.pending && (
        <Tag size='small' color='orange'>
          {t(effect === 'restart' ? `${KEY}.row.pendingRestart` : `${KEY}.row.pendingNext`)}
        </Tag>
      )}
      {row.lock && (
        <Tooltip content={lockReason(t, row.lock.reason)}>
          <Tag size='small' icon={<Lock size={12} />} data-testid={`aelix-tool-lock-${row.key}`}>
            {lockReason(t, row.lock.reason)}
          </Tag>
        </Tooltip>
      )}
      {row.problem && (
        <Tag size='small' color='red'>
          {t(`${KEY}.row.problem`, { code: row.problem })}
        </Tag>
      )}
      {row.mismatches.map((mismatch) => (
        <Tag key={mismatch.reason} size='small' color='orange' data-testid={`aelix-tool-mismatch-${row.key}`}>
          {t(`${KEY}.row.mismatch`, { reason: mismatch.reason })}
        </Tag>
      ))}
    </div>
  );
};

/** The names a save would send: editable loaded rows from the draft, locked rows as their lock holds them. */
function namesFor(rows: readonly ResourceRow[], draft: ReadonlySet<string>): string[] {
  return rows
    .filter((row) => row.role === 'item' && row.loaded === true)
    .filter((row) => (row.lock ? row.lock.value : draft.has(row.key)))
    .map((row) => row.key);
}

function initialDraft(tools: SessionSelections): Set<string> {
  if (tools.toolOverride !== null) return new Set(tools.toolOverride);
  if (tools.activeTools !== null) return new Set(tools.activeTools);
  return new Set(tools.items.filter((row) => row.inForce === true).map((row) => row.key));
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** "This conversation's tools": an explicit list (including none) or inherit from profile and defaults. */
const ToolsPanel: React.FC<{ controls: AelixSessionControls }> = ({ controls }) => {
  const { t } = useTranslation();
  const { availability, tools, skills, profiles } = controls;
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const blocked = writeBlockedText(t, controls);

  useEffect(() => {
    if (!tools) return;
    setDraft(initialDraft(tools));
    setDirty(false);
  }, [tools]);

  const rows = tools?.items ?? [];
  const saveNames = useMemo(() => namesFor(rows, draft), [rows, draft]);

  if (availability.kind !== 'ready') return <AvailabilityNotice controls={controls} />;
  const { capabilities } = availability;
  if (!capabilities.selectionsList || !capabilities.setActiveTools) return <UpdateRequired />;

  const override = tools?.toolOverride ?? null;
  const complete = tools?.complete === true;
  const baselineNames = tools ? namesFor(rows, initialDraft(tools)) : [];
  const changed = dirty && !sameNames(saveNames, baselineNames);
  // Inherit returns only through a profile write, which resets the conversation override.
  const active = profiles?.activeRef ?? null;
  const canInherit =
    override !== null &&
    capabilities.profilesUse &&
    !controls.profileUseUnsupported &&
    (active !== null || !profiles?.activeAgent);

  const toggle = (key: string, checked: boolean) => {
    setDraft((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
    setDirty(true);
  };

  return (
    <div className='flex flex-col gap-10px' data-testid='aelix-tools-panel'>
      <div className='flex flex-col gap-2px'>
        <div className='text-13px text-t-primary' data-testid='aelix-tools-mode'>
          {override === null
            ? t(`${KEY}.tools.modeInherited`)
            : override.length === 0
              ? t(`${KEY}.tools.modeNone`)
              : t(`${KEY}.tools.modeExplicit`, { total: String(override.length) })}
        </div>
        <div className='text-12px text-t-secondary'>
          {t(tools?.effect === 'restart' ? `${KEY}.tools.effectRestart` : `${KEY}.tools.effectNext`)}
        </div>
      </div>
      <WriteOutcome controls={controls} />
      {controls.toolsFailure && <Alert type='error' content={t(`${KEY}.status.readFailed`)} />}
      {tools?.policyPending && <Alert type='info' content={t(`${KEY}.tools.policyPending`)} />}
      {tools && !complete && (
        <Alert type='warning' data-testid='aelix-tools-partial' content={t(`${KEY}.tools.partial`)} />
      )}
      {tools && tools.mismatches.some(({ key }) => key === null) && (
        <Alert type='warning' content={t(`${KEY}.tools.mismatch`)} />
      )}
      {tools && rows.length === 0 && <div className='text-12px text-t-secondary'>{t(`${KEY}.tools.empty`)}</div>}
      <div className='flex flex-col gap-6px max-h-280px overflow-auto' data-testid='aelix-tools-list'>
        {rows.map((row) =>
          row.role === 'item' ? (
            <div key={row.key} className='flex flex-col gap-2px'>
              <Checkbox
                checked={row.lock ? row.lock.value : draft.has(row.key)}
                disabled={row.loaded !== true || row.lock !== null || Boolean(blocked)}
                onChange={(checked: boolean) => toggle(row.key, checked)}
                data-testid={`aelix-tool-${row.key}`}
              >
                <span className='text-13px text-t-primary'>{row.label}</span>
                {row.loaded !== true && (
                  <span className='ml-6px text-11px text-t-tertiary'>{t(`${KEY}.row.notLoaded`)}</span>
                )}
              </Checkbox>
              <div className='pl-24px'>
                <RowState row={row} effect={tools?.effect ?? 'next_request'} />
              </div>
            </div>
          ) : (
            <div key={row.key} className='text-12px text-t-secondary'>
              {row.label}
            </div>
          )
        )}
      </div>
      {skills && (
        <div className='text-12px text-t-secondary' data-testid='aelix-skills-summary'>
          {t(`${KEY}.tools.skills`, {
            skills:
              skills.items
                .filter((row) => row.role === 'item' && row.inForce === true)
                .map((row) => row.label)
                .join(', ') || t(`${KEY}.value.empty`),
          })}
        </div>
      )}
      <div className='flex flex-wrap justify-end gap-8px'>
        {canInherit && (
          <Tooltip content={blocked} disabled={!blocked}>
            <Button
              size='small'
              disabled={Boolean(blocked)}
              onClick={() => void controls.applyProfile(active)}
              data-testid='aelix-tools-inherit'
            >
              {t(`${KEY}.tools.inherit`)}
            </Button>
          </Tooltip>
        )}
        <Button
          size='small'
          disabled={Boolean(blocked) || rows.every((row) => row.lock !== null || !draft.has(row.key))}
          onClick={() => {
            setDraft(new Set());
            setDirty(true);
          }}
          data-testid='aelix-tools-none'
        >
          {t(`${KEY}.tools.selectNone`)}
        </Button>
        <Tooltip content={blocked ?? (complete ? null : t(`${KEY}.tools.partial`))} disabled={!blocked && complete}>
          <Button
            size='small'
            type='primary'
            loading={controls.writing === 'tools'}
            disabled={!changed || !complete || Boolean(blocked)}
            onClick={() => void controls.saveTools(saveNames)}
            data-testid='aelix-tools-save'
          >
            {t(`${KEY}.tools.save`)}
          </Button>
        </Tooltip>
      </div>
      {blocked && !controls.writing && (
        <div className='text-12px text-t-secondary' data-testid='aelix-controls-blocked'>
          {blocked}
        </div>
      )}
    </div>
  );
};

export default ToolsPanel;
