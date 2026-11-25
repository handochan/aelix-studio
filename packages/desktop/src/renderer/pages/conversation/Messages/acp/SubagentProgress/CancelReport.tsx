import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CancelReportView } from './types';

/** Native's own words for one child, kept verbatim and bounded in height. */
const ReportText: React.FC<{ text: string }> = ({ text }) => (
  <div
    data-subagent-report-text
    className='mt-4px max-h-240px overflow-auto whitespace-pre-wrap break-words rounded bg-fill-2 p-8px font-mono text-12px text-t-primary'
  >
    {text}
  </div>
);

const NOTICE_KEYS = {
  missing: 'acp.subagents.report.missing',
  unreadable: 'acp.subagents.report.unreadable',
  loadFailed: 'acp.subagents.report.loadFailed',
} as const;

/**
 * What a cancelled call's children did, below its rows. A batch is listed by
 * submitted position, the only identity native's report carries; it is never
 * matched to a progress row.
 */
const CancelReport: React.FC<{ report: CancelReportView }> = ({ report }) => {
  const { t } = useTranslation();
  const title = t('acp.subagents.report.title');
  if (report.kind === 'missing' || report.kind === 'unreadable' || report.kind === 'loadFailed') {
    return (
      <div data-subagent-report={report.kind} className='mt-8px text-12px text-t-secondary'>
        {t(NOTICE_KEYS[report.kind])}
      </div>
    );
  }
  return (
    <section
      aria-label={title}
      data-subagent-report={report.kind}
      className='mt-8px flex flex-col gap-8px min-w-0 text-12px text-t-secondary'
    >
      <div className='font-medium text-t-primary'>{title}</div>
      {report.kind === 'single' ? (
        <ReportText text={report.text} />
      ) : (
        report.entries.map((entry) => (
          <div
            key={entry.position}
            data-subagent-report-position={entry.position}
            data-subagent-report-entry={entry.kind}
          >
            <div className='font-medium text-t-primary'>
              {t(report.noun === 'step' ? 'acp.subagents.report.step' : 'acp.subagents.report.task', {
                index: entry.position,
                total: report.total,
              })}
            </div>
            {entry.kind === 'ran' ? (
              <ReportText text={entry.text} />
            ) : (
              <div className='mt-4px'>
                {t(entry.kind === 'lost' ? 'acp.subagents.report.lost' : 'acp.subagents.report.idle')}
              </div>
            )}
          </div>
        ))
      )}
    </section>
  );
};

export default CancelReport;
