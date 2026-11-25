import type { BadgeProps } from '@arco-design/web-react';
import { Badge, Button, Message, Spin, Tooltip } from '@arco-design/web-react';
import { IconDown, IconRight } from '@arco-design/web-react/icon';
import { Checklist, Download, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { getAcpImageFileName } from '@/common/chat/acpToolCallOutput';
import type { NormalizedToolCall, NormalizedToolStatus, ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages } from '@/common/chat/normalizeToolCall';
import LocalImageView from '@/renderer/components/media/LocalImageView';
import { downloadFileFromPath } from '@/renderer/utils/file/download';
import SubagentProgressPanel, {
  presentCancelReport,
  presentSubagentTool,
  type SubagentPresentation,
} from '../acp/SubagentProgress';
import { readAcpCompaction, type AcpCompaction } from '../acp/compaction';
import './MessageToolGroupSummary.css';

/** Fetches of a compact row before its stored copy is treated as unavailable. */
const FULL_LOAD_ATTEMPTS = 3;
const FULL_LOAD_RETRY_MS = 400;

const statusToBadge = (status: NormalizedToolStatus): BadgeProps['status'] => {
  switch (status) {
    case 'completed':
      return 'success';
    case 'error':
      return 'error';
    case 'running':
      return 'processing';
    case 'canceled':
      return 'default';
    case 'pending':
    default:
      return 'default';
  }
};

const ToolItemDetail: React.FC<{
  item: NormalizedToolCall;
  subagents?: SubagentPresentation | null;
  compaction?: AcpCompaction | null;
}> = ({ item, subagents, compaction }) => {
  const { t, i18n } = useTranslation();
  const interrupted = subagents?.interrupted ?? false;
  // The call's own status: a parent projected from stopped rows has not delivered its result yet.
  const callStatus = subagents?.callStatus ?? item.status;
  const callEnded = callStatus === 'completed' || callStatus === 'error' || callStatus === 'canceled';
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [fullItem, setFullItem] = useState<NormalizedToolCall | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const displayItem = fullItem ?? item;
  const hasDetail = displayItem.input || displayItem.output || item.truncated || item.imagePath;
  const [messageApi, messageContext] = Message.useMessage();
  const handleDownloadImage = useCallback(
    async (path: string) => {
      try {
        await downloadFileFromPath(path, getAcpImageFileName(path));
        messageApi.success(t('acp.image.download_success'));
      } catch {
        console.error('[MessageToolGroupSummary] Failed to download image');
        messageApi.error(t('acp.image.download_error'));
      }
    },
    [messageApi, t]
  );

  // A live update supersedes whatever was fetched for an earlier version of this call.
  const version = `${callStatus}\u0000${item.output ?? ''}`;
  const currentVersion = useRef(version);
  currentVersion.current = version;
  useEffect(() => {
    setFullItem(null);
    setLoadError(false);
  }, [version]);

  const loadFullItem = useCallback(async () => {
    if (!item.truncated || fullItem || loadingFull) return;
    if (!item.conversationId || !item.messageId) {
      setLoadError(true);
      return;
    }
    const requested = currentVersion.current;
    setLoadingFull(true);
    setLoadError(false);
    try {
      // The stored row can trail the live update that ended the call by one write.
      for (let attempt = 0; attempt < FULL_LOAD_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FULL_LOAD_RETRY_MS));
        const message = await ipcBridge.database.getConversationMessage.invoke({
          conversation_id: item.conversationId,
          message_id: item.messageId,
        });
        if (currentVersion.current !== requested) return;
        const next = normalizeToolMessages([message as ToolMessage]).find((candidate) => candidate.key === item.key);
        if (!next) break;
        if (next.status === callStatus) {
          setFullItem(next);
          return;
        }
      }
      setLoadError(true);
    } catch {
      if (currentVersion.current === requested) setLoadError(true);
    } finally {
      setLoadingFull(false);
    }
  }, [item, fullItem, loadingFull, callStatus]);

  // A delegating call's full result is fetched once the call itself ended, expanded or not.
  useEffect(() => {
    if (subagents && callEnded && item.truncated && !fullItem && !loadError) void loadFullItem();
  }, [subagents, callEnded, item.truncated, fullItem, loadError, loadFullItem]);

  const pendingFull = item.truncated === true && fullItem === null;
  const report = useMemo(
    () =>
      subagents
        ? presentCancelReport(subagents, displayItem.output, { pending: pendingFull, loadFailed: loadError })
        : null,
    [subagents, displayItem.output, pendingFull, loadError]
  );
  // A parsed report already shows the children's work; only a notice falls back to the raw output.
  const reportShown = report?.kind === 'single' || report?.kind === 'batch';
  const waitingForFull = subagents !== undefined && subagents !== null && pendingFull && !loadError;
  const autoExpanded = interrupted && callEnded && !reportShown && !waitingForFull;
  const expanded = userExpanded ?? autoExpanded;

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setUserExpanded(nextExpanded);
    if (nextExpanded) void loadFullItem();
  };

  if (compaction) {
    const { reason, state, tokensBefore } = compaction;
    const title = t(reason === 'manual' ? 'acp.compaction.manual' : 'acp.compaction.automatic');
    const detail =
      state === 'running' && reason === 'manual'
        ? t('acp.compaction.runningManual')
        : state === 'completed' && tokensBefore !== undefined
          ? t('acp.compaction.completedWithTokens', {
              tokens: new Intl.NumberFormat(i18n?.resolvedLanguage).format(tokensBefore),
            })
          : t(`acp.compaction.${state}`);
    return (
      <div className='flex items-center gap-12px text-t-secondary' role='status' data-tool-call-id={item.key}>
        <Badge status={statusToBadge(state === 'aborted' || state === 'unknown' ? 'canceled' : item.status)} />
        <span className='text-13px'>
          <span className='font-medium'>{title}</span> {detail}
        </span>
      </div>
    );
  }

  return (
    <div className='flex flex-col' data-tool-call-id={subagents ? item.key : undefined}>
      {messageContext}
      <div className='flex flex-row color-#86909C gap-12px items-center'>
        <Badge status={statusToBadge(item.status)} className={item.status === 'running' ? 'badge-breathing' : ''} />
        <span
          className={
            'flex-1 min-w-0' +
            (expanded ? ' break-all' : ' truncate') +
            (hasDetail ? ' cursor-pointer hover:color-#4E5969' : '')
          }
          onClick={hasDetail ? toggleExpanded : undefined}
        >
          <span className='font-medium text-13px'>{displayItem.name}</span>
          {displayItem.description && displayItem.description !== displayItem.name && (
            <span className='m-l-4px opacity-80 text-13px'>{displayItem.description}</span>
          )}
        </span>
        {hasDetail && (
          <span className='flex-shrink-0 cursor-pointer hover:color-#4E5969 transition-colors' onClick={toggleExpanded}>
            {expanded ? <IconDown style={{ fontSize: 12 }} /> : <IconRight style={{ fontSize: 12 }} />}
          </span>
        )}
      </div>
      {subagents && <SubagentProgressPanel progress={subagents.progress} report={report} />}
      {expanded && hasDetail && (
        <div className='tool-detail-panel m-l-20px m-t-4px'>
          {loadingFull && <div className='tool-detail-label'>Loading...</div>}
          {loadError && <div className='tool-detail-label'>Failed to load full output</div>}
          {displayItem.input && (
            <div className='tool-detail-section'>
              <div className='tool-detail-label'>Input</div>
              <pre className='tool-detail-content'>{displayItem.input}</pre>
            </div>
          )}
          {displayItem.output && (
            <div className='tool-detail-section'>
              <div className='tool-detail-label'>Output</div>
              <pre className='tool-detail-content'>{displayItem.output}</pre>
            </div>
          )}
        </div>
      )}
      {item.imagePath && (
        <div className='group relative m-l-20px m-t-8px overflow-hidden rounded border bg-1 p-2 max-w-280px'>
          <LocalImageView
            src={item.imagePath}
            alt={getAcpImageFileName(item.imagePath)}
            className='max-w-full max-h-320px object-contain rounded'
          />
          <Tooltip content={t('acp.image.download')}>
            <Button
              aria-label={t('acp.image.download_aria')}
              className='!absolute end-10px top-10px !h-28px !w-28px !p-0 opacity-0 shadow-sm transition-opacity group-hover:opacity-90 focus:opacity-100'
              type='secondary'
              size='mini'
              shape='circle'
              icon={<Download theme='outline' size='14' />}
              onClick={() => void handleDownloadImage(item.imagePath)}
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
};

const MessageToolGroupSummary: React.FC<{ messages: ToolMessage[] }> = ({ messages }) => {
  const extensionsByCall = useMemo(
    () =>
      new Map<string, unknown>(
        messages.flatMap((message) =>
          message.type === 'acp_tool_call' && message.content?.update && message.content._meta !== undefined
            ? [[message.content.update.tool_call_id, message.content._meta] as const]
            : []
        )
      ),
    [messages]
  );
  const normalized = useMemo(() => normalizeToolMessages(messages), [messages]);
  const presented = useMemo(
    () =>
      normalized.map((item) => {
        const extension = extensionsByCall.get(item.key);
        const subagents = extension ? presentSubagentTool(extension, item.status) : null;
        const compaction = readAcpCompaction(extension);
        return { item: subagents ? { ...item, status: subagents.parentStatus } : item, subagents, compaction };
      }),
    [normalized, extensionsByCall]
  );
  const tools = presented.map(({ item }) => item);
  const hasProgressDetails = presented.some(({ subagents, compaction }) => subagents !== null || compaction !== null);
  const hasRunning = tools.some((item) => item.status === 'running');
  const [showMore, setShowMore] = useState(hasRunning || hasProgressDetails);
  const userToggled = useRef(false);

  useEffect(() => {
    if ((hasRunning || hasProgressDetails) && (!hasProgressDetails || !userToggled.current)) setShowMore(true);
  }, [hasRunning, hasProgressDetails]);

  return (
    <div className='tool-group-summary'>
      <div
        className='tool-group-summary__header'
        onClick={() => {
          userToggled.current = true;
          setShowMore(!showMore);
        }}
      >
        <span className='tool-group-summary__icon'>
          {hasRunning ? <Spin size={12} /> : <Checklist theme='outline' size='14' />}
        </span>
        <span className='tool-group-summary__label'>View Steps {tools.length > 0 ? `· ${tools.length}` : ''}</span>
        <span className={`tool-group-summary__arrow${showMore ? ' tool-group-summary__arrow--open' : ''}`}>
          <Right theme='outline' size='12' />
        </span>
      </div>
      {showMore && (
        <div className='tool-group-summary__body'>
          {presented.map(({ item, subagents, compaction }) => (
            <ToolItemDetail key={item.key} item={item} subagents={subagents} compaction={compaction} />
          ))}
        </div>
      )}
    </div>
  );
};

export default React.memo(MessageToolGroupSummary);
