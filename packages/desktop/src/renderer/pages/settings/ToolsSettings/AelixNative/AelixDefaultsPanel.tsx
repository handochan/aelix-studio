/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Radio, Spin, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResourceFailure, ResourceKind } from '@/renderer/services/runtime/NativeResources';
import { failureLabel } from './labels';
import SelectionList from './SelectionList';
import { useConversationWorkspace, useNativeClient } from './useNativeClient';
import type { SelectionTarget } from './useSelections';

export type AelixDefaultsPanelProps = {
  /** Kinds shown in this panel, for example tools and MCP on the Tools page. */
  kinds: readonly ResourceKind[];
  /** Conversation that opened settings. Enables the "This project" scope for its workspace. */
  conversationId?: string | null;
  description?: string;
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
const AelixDefaultsPanel: React.FC<AelixDefaultsPanelProps> = ({ kinds, conversationId, description }) => {
  const { t } = useTranslation();
  const client = useNativeClient();
  const [scope, setScope] = useState<'global' | 'project'>(conversationId ? 'project' : 'global');
  const [kind, setKind] = useState<ResourceKind>(kinds[0]);
  const [project, setProject] = useState<ProjectState>();
  const workspace = useConversationWorkspace(conversationId);
  const discovery = useRef(0);

  useEffect(() => {
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
      return globalTarget ? <SelectionList key={`global:${kind}`} target={globalTarget} kind={kind} /> : <Spin />;
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
      return <Alert type='warning' data-testid='aelix-project-failure' content={t(key, values)} />;
    }
    return (
      <SelectionList
        key={`project:${conversationId}:${kind}`}
        target={project.target}
        kind={kind}
        onRediscover={() => void discover()}
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
    <div className='flex flex-col gap-12px' data-testid='aelix-defaults-panel'>
      <div className='flex flex-col gap-4px'>
        <Typography.Text className='text-14px text-t-primary'>{t(`${P}.title`)}</Typography.Text>
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
