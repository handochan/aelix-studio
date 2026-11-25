/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Radio, Spin, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResourceFailure, ResourceKind } from '@/renderer/services/runtime/NativeResources';
import { failureLabel } from './labels';
import SelectionList from './SelectionList';
import { useConversationWorkspace, useNativeClient } from './useNativeClient';
import type { NoticeCache, SelectionTarget } from './useSelections';

export type AelixDefaultsPanelProps = {
  /** Kinds shown in this panel, for example tools and MCP on the Tools page. */
  kinds: readonly ResourceKind[];
  /** Conversation that opened settings. Enables the "This project" scope for its workspace. */
  conversationId?: string | null;
  description?: string;
  /** Wait to read the global helper until the panel scrolls into view (for long pages). */
  deferUntilVisible?: boolean;
};

type ProjectState =
  | { status: 'loading' }
  | { status: 'ready'; target: SelectionTarget }
  | { status: 'failed'; failure: ResourceFailure };

const P = 'settings.aelixNative';

const invalidConversation: ResourceFailure = {
  status: 'invalid-input',
  reason: 'invalid-conversation',
  action: 'refresh',
  retryWrite: false,
};

/**
 * Native Aelix defaults for tools, skills and MCP. Data comes only from NativeResources, never
 * from the Aion catalog, so the Aion lists on the same page keep their own CRUD and import.
 */
/** Become true once the element is on screen; true at once where visibility cannot be observed. */
function useSeen(element: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [seen, setSeen] = useState(!enabled || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = element.current;
    if (seen || !node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element, seen]);
  return seen;
}

const AelixDefaultsPanel: React.FC<AelixDefaultsPanelProps> = ({
  kinds,
  conversationId,
  description,
  deferUntilVisible = false,
}) => {
  const { t } = useTranslation();
  const client = useNativeClient();
  const root = useRef<HTMLDivElement>(null);
  const seen = useSeen(root, deferUntilVisible && !conversationId);
  const [scope, setScope] = useState<'global' | 'project'>(conversationId ? 'project' : 'global');
  const [kind, setKind] = useState<ResourceKind>(kinds[0]);
  const [project, setProject] = useState<ProjectState>();
  const workspace = useConversationWorkspace(conversationId);
  const discovery = useRef(0);
  const notices = useRef<NoticeCache>(new Map());

  useEffect(() => {
    // Another conversation is another project: drop its binding, discovery and notices.
    discovery.current++;
    notices.current = new Map();
    setProject(undefined);
    setScope(conversationId ? 'project' : 'global');
  }, [conversationId]);

  const globalTarget = useMemo<SelectionTarget | undefined>(
    () => (client ? { scope: 'global', client } : undefined),
    [client]
  );

  const discover = useCallback(async () => {
    if (!client || !conversationId) return;
    const run = ++discovery.current;
    let session;
    try {
      session = client.session(conversationId);
    } catch {
      setProject({ status: 'failed', failure: invalidConversation });
      return;
    }
    setProject({ status: 'loading' });
    session.invalidate();
    const reply = await session.discover();
    if (run !== discovery.current) return;
    if (reply.status !== 'success') {
      setProject({ status: 'failed', failure: reply });
    } else if (!reply.data.selectionsList) {
      setProject({
        status: 'failed',
        failure: { status: 'unsupported', reason: 'unsupported', action: 'disable-control', retryWrite: false },
      });
    } else {
      setProject({
        status: 'ready',
        target: { scope: 'project', conversationId, session, canWrite: reply.data.selectionsSet },
      });
    }
  }, [client, conversationId]);

  useEffect(() => {
    if (scope === 'project') void discover();
  }, [discover, scope]);

  const renderBody = () => {
    if (scope === 'global') {
      if (!seen) return null;
      return globalTarget ? (
        <SelectionList key={`global:${kind}`} target={globalTarget} kind={kind} notices={notices.current} />
      ) : (
        <Spin />
      );
    }
    if (!project || project.status === 'loading') {
      return (
        <div className='flex justify-center py-16px'>
          <Spin tip={t(`${P}.loading`)} />
        </div>
      );
    }
    if (project.status === 'failed') {
      const { key, values } = failureLabel(project.failure);
      return (
        <Alert
          type={project.failure.status === 'unsupported' ? 'info' : 'warning'}
          data-testid='aelix-project-failure'
          content={
            <div className='flex flex-wrap items-center gap-8px'>
              <span>{t(key, values)}</span>
              {project.failure.status === 'unsupported' ? null : (
                <Button size='mini' data-testid='aelix-project-retry' onClick={() => void discover()}>
                  {t(`${P}.reload`)}
                </Button>
              )}
            </div>
          }
        />
      );
    }
    return (
      <SelectionList
        key={`project:${conversationId}:${kind}`}
        target={project.target}
        kind={kind}
        onRediscover={() => void discover()}
        notices={notices.current}
      />
    );
  };

  const workspaceText =
    workspace?.status === 'ready' && workspace.workspace
      ? t(`${P}.workspace`, { path: workspace.workspace })
      : workspace?.status === 'loading'
        ? t(`${P}.loading`)
        : t(`${P}.workspaceUnknown`);

  return (
    <div ref={root} className='flex flex-col gap-12px' data-testid='aelix-defaults-panel'>
      <div className='flex flex-col gap-4px'>
        <Typography.Text className='text-14px text-t-primary' data-testid='aelix-defaults-title'>
          {t(scope === 'project' ? `${P}.titleProject` : `${P}.title`)}
        </Typography.Text>
        <Typography.Text className='text-12px text-t-secondary'>{description ?? t(`${P}.description`)}</Typography.Text>
      </div>

      <div className='flex flex-wrap items-center gap-12px'>
        {conversationId ? (
          <Radio.Group
            type='button'
            size='small'
            value={scope}
            onChange={(value: 'global' | 'project') => {
              // Returning to the project scope discovers the binding again before listing.
              setProject(undefined);
              setScope(value);
            }}
            data-testid='aelix-scope'
            aria-label={t(`${P}.scope.label`)}
          >
            <Radio value='global'>{t(`${P}.scope.global`)}</Radio>
            <Radio value='project'>{t(`${P}.scope.project`)}</Radio>
          </Radio.Group>
        ) : null}
        {kinds.length > 1 ? (
          <Radio.Group
            type='button'
            size='small'
            value={kind}
            onChange={(value: ResourceKind) => setKind(value)}
            data-testid='aelix-kind'
            aria-label={t(`${P}.kind.label`)}
          >
            {kinds.map((entry) => (
              <Radio key={entry} value={entry}>
                {t(`${P}.kind.${entry}`)}
              </Radio>
            ))}
          </Radio.Group>
        ) : null}
      </div>

      {scope === 'project' ? (
        <div className='flex flex-col gap-8px'>
          <Typography.Text className='text-12px text-t-secondary break-all' data-testid='aelix-workspace'>
            {workspaceText}
          </Typography.Text>
          <Alert
            type='warning'
            data-testid='aelix-project-impact'
            content={
              <div className='flex flex-col gap-4px'>
                <span>{t(`${P}.projectImpact`)}</span>
                <span>{t(kind === 'tool' ? `${P}.toolOverrideHint` : `${P}.noConversationOverride`)}</span>
              </div>
            }
          />
        </div>
      ) : null}

      {renderBody()}
    </div>
  );
};

export default AelixDefaultsPanel;
