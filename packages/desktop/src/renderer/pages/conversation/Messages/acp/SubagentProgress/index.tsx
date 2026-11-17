import { Badge } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentProgress, SubagentState } from './types';
export { presentSubagentTool } from './presentation';
export type { SubagentPresentation } from './types';

const STATUS = {
  starting: 'processing',
  running: 'processing',
  done: 'success',
  error: 'error',
  stopped: 'default',
  unknown: 'warning',
  ended: 'default',
} as const;
const STATE_KEYS = {
  starting: 'acp.subagents.states.starting',
  running: 'acp.subagents.states.running',
  done: 'acp.subagents.states.done',
  error: 'acp.subagents.states.error',
  stopped: 'acp.subagents.states.stopped',
  unknown: 'acp.subagents.states.unknown',
  ended: 'acp.subagents.states.ended',
} as const satisfies Record<SubagentState, string>;

/** Render one parent call's latest snapshot. Resume is a new call, with its own rows. */
const SubagentProgressPanel: React.FC<{ progress: SubagentProgress }> = ({ progress }) => {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n?.language, { maximumSignificantDigits: 6 });
  const tokens = new Intl.NumberFormat(i18n?.language, { maximumFractionDigits: 0 });
  const seconds = new Intl.NumberFormat(i18n?.language, { maximumFractionDigits: 1 });
  const unavailable = t('acp.subagents.unavailable');
  return (
    <div role='list' aria-label={t('acp.subagents.title')} className='flex flex-col gap-8px mt-8px min-w-0'>
      {progress.children.map((child, index) => (
        <div
          key={child.id}
          role='listitem'
          data-subagent-id={child.id}
          data-subagent-state={child.state}
          className='rounded border border-3 bg-1 p-10px text-12px text-t-secondary break-words'
        >
          <div className='flex flex-wrap items-center gap-8px text-t-primary'>
            <span className='font-medium'>
              {t('acp.subagents.child', {
                profile: child.profile ?? t('acp.subagents.unknownProfile'),
                index: index + 1,
              })}
            </span>
            <Badge status={STATUS[child.state]} text={t(STATE_KEYS[child.state])} />
          </div>
          <div className='flex flex-wrap gap-x-16px gap-y-4px mt-4px'>
            <span>{t('acp.subagents.tool', { value: child.currentTool ?? unavailable })}</span>
            <span title={t('acp.subagents.elapsedHint')}>
              {t(
                child.state === 'starting' || child.state === 'running' || child.state === 'ended'
                  ? 'acp.subagents.elapsedReported'
                  : 'acp.subagents.elapsed',
                {
                  value: child.elapsedMs === undefined ? unavailable : seconds.format(child.elapsedMs / 1000),
                }
              )}
            </span>
            <span data-subagent-metric='tokens'>
              {t('acp.subagents.tokens', {
                value: child.tokens === undefined ? unavailable : tokens.format(child.tokens),
              })}
            </span>
            <span data-subagent-metric='cost'>
              {t('acp.subagents.cost', { value: child.cost === undefined ? unavailable : number.format(child.cost) })}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default React.memo(SubagentProgressPanel);
