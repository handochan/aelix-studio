/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Spin, Tag, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GlobalProfiles,
  ProfilePreview,
  ResourceFailure,
  ResourceResult,
} from '@/renderer/services/runtime/NativeResources';
import { approvalModeLabel, diagnosticLabel, failureLabel, promptModeLabel, type Label } from './labels';
import { useNativeClient } from './useNativeClient';

type AelixProfilesProps = {
  /** Open the list on mount, for example from the assistant editor's profile link. */
  defaultExpanded?: boolean;
  /** Profile name to preview once the list loads. */
  focusProfile?: string | null;
};

type PreviewState =
  | { name: string; status: 'loading' }
  | { name: string; status: 'ready'; profile: ProfilePreview }
  | { name: string; status: 'changed' }
  | { name: string; status: 'failed'; failure: ResourceFailure };

const P = 'settings.aelixNative.profiles';
const MAX_PAGES = 25;

const listValue = (values: readonly string[] | null, inherit: string, none: string) =>
  values === null ? inherit : values.length === 0 ? none : values.join(', ');

/**
 * Discover and preview globally available Aelix profiles. This is read-only: profiles are made
 * with the Aelix CLI and chosen per conversation in the composer.
 */
const AelixProfiles: React.FC<AelixProfilesProps> = ({ defaultExpanded = false, focusProfile }) => {
  const { t } = useTranslation();
  const client = useNativeClient();
  const [expanded, setExpanded] = useState(defaultExpanded || Boolean(focusProfile));
  const [catalog, setCatalog] = useState<GlobalProfiles>();
  const [failure, setFailure] = useState<ResourceFailure>();
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewState>();
  const ticket = useRef(0);
  const previewTicket = useRef(0);
  const focused = useRef(false);

  const load = useCallback(async () => {
    if (!client) return;
    const run = ++ticket.current;
    setLoading(true);
    let reply: ResourceResult<GlobalProfiles> = await client.global.listProfiles();
    for (let page = 1; reply.status === 'success' && reply.data.nextCursor !== null && page < MAX_PAGES; page++) {
      // Each page continues the previous cursor.
      // oxlint-disable-next-line no-await-in-loop
      reply = await client.global.nextProfiles(reply.data);
    }
    if (run !== ticket.current) return;
    setLoading(false);
    // A new list retires any preview, including one still in flight.
    previewTicket.current++;
    setPreview(undefined);
    if (reply.status === 'success') {
      setCatalog(reply.data);
      setFailure(undefined);
    } else {
      setCatalog(undefined);
      setFailure(reply);
    }
  }, [client]);

  useEffect(() => {
    // A new client (for example after a user change) starts from an empty catalog.
    ticket.current++;
    previewTicket.current++;
    setCatalog(undefined);
    setFailure(undefined);
    setPreview(undefined);
  }, [client]);

  useEffect(() => {
    if (expanded) void load();
  }, [expanded, load]);

  const inspect = useCallback(
    async (name: string) => {
      if (!client) return;
      const run = ++previewTicket.current;
      setPreview({ name, status: 'loading' });
      const reply = await client.global.showProfile(name);
      // Only the latest request may fill the preview; earlier replies are dropped.
      if (run !== previewTicket.current) return;
      if (reply.status !== 'success') {
        setPreview({ name, status: 'failed', failure: reply });
        return;
      }
      // The preview counts only when it is the same file revision the list shows.
      const inspected = client.global.profileView()?.inspected;
      setPreview(
        inspected && inspected.ref.name === name
          ? { name, status: 'ready', profile: inspected }
          : { name, status: 'changed' }
      );
    },
    [client]
  );

  useEffect(() => {
    if (!catalog || !focusProfile || focused.current) return;
    focused.current = true;
    if (catalog.profiles.some((entry) => entry.ref.name === focusProfile)) void inspect(focusProfile);
  }, [catalog, focusProfile, inspect]);

  const renderPreview = (state: PreviewState) => {
    if (state.status === 'loading') return <Spin size={16} />;
    if (state.status === 'changed') return <Alert type='warning' content={t(`${P}.changed`)} />;
    if (state.status === 'failed') {
      const label: Label =
        state.failure.reason === 'PROFILE_UNAVAILABLE' ? { key: `${P}.unavailable` } : failureLabel(state.failure);
      return <Alert type='warning' content={t(label.key, label.values)} />;
    }
    const { profile } = state;
    const inherit = t(`${P}.inherit`);
    const none = t(`${P}.none`);
    const fields: [string, string][] = [
      [t(`${P}.source`), profile.source],
      [t(`${P}.model`), [profile.provider, profile.model].filter(Boolean).join(' / ') || inherit],
      [t(`${P}.tools`), listValue(profile.tools, inherit, none)],
      [t(`${P}.skills`), listValue(profile.skills, inherit, none)],
      [
        t(`${P}.approvalMode`),
        t(approvalModeLabel(profile.approvalMode).key, approvalModeLabel(profile.approvalMode).values),
      ],
      [t(`${P}.promptMode`), t(promptModeLabel(profile.promptMode).key, promptModeLabel(profile.promptMode).values)],
    ];
    return (
      <div className='flex flex-col gap-6px text-12px' data-testid={`aelix-profile-preview-${profile.ref.name}`}>
        {fields.map(([name, value]) => (
          <div key={name} className='flex gap-8px'>
            <span className='w-120px shrink-0 text-t-secondary'>{name}</span>
            <span className='min-w-0 break-all text-t-primary'>{value}</span>
          </div>
        ))}
        <div className='flex flex-col gap-4px'>
          <span className='text-t-secondary'>
            {t(`${P}.prompt`)}
            {profile.promptTruncated ? ` ${t(`${P}.truncated`)}` : ''}
          </span>
          <pre className='m-0 max-h-160px overflow-auto whitespace-pre-wrap rd-6px bg-fill-1 p-8px text-t-primary'>
            {profile.promptPreview}
          </pre>
        </div>
      </div>
    );
  };

  return (
    <div
      className='flex flex-col gap-8px rd-12px border border-border-2 border-solid bg-base px-14px py-10px'
      data-testid='aelix-profiles'
    >
      <div className='flex items-center justify-between gap-8px'>
        <div className='flex min-w-0 items-center gap-8px'>
          <Typography.Text className='text-13px font-medium text-t-primary'>{t(`${P}.title`)}</Typography.Text>
          {catalog ? <Tag size='small'>{t(`${P}.count`, { count: catalog.profiles.length })}</Tag> : null}
          {catalog && catalog.diagnostics.length > 0 ? (
            <Tag size='small' color='orange'>
              {t(`${P}.diagnosticCount`, { count: catalog.diagnostics.length })}
            </Tag>
          ) : null}
        </div>
        <Button
          size='mini'
          data-testid='aelix-profiles-toggle'
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t(`${P}.hide`) : t(`${P}.show`)}
        </Button>
      </div>
      {expanded ? (
        <div className='flex flex-col gap-8px'>
          <Typography.Text className='text-12px text-t-secondary'>
            {t(`${P}.description`)} {t(`${P}.hint`)}
          </Typography.Text>
          {loading && !catalog ? <Spin size={16} /> : null}
          {failure ? (
            <Alert
              type={failure.status === 'unsupported' ? 'info' : 'warning'}
              data-testid='aelix-profiles-failure'
              content={t(failureLabel(failure).key, failureLabel(failure).values)}
            />
          ) : null}
          {catalog && catalog.diagnostics.length > 0 ? (
            <Alert
              type='warning'
              data-testid='aelix-profiles-diagnostics'
              title={t('settings.aelixNative.diagnostics.title')}
              content={
                <ul className='m-0 ps-16px'>
                  {catalog.diagnostics.map((entry) => {
                    const label = diagnosticLabel(entry.code);
                    return (
                      <li key={`${entry.code}:${entry.source ?? ''}:${entry.key ?? ''}`}>
                        {t(label.key, label.values)}
                        {entry.source ? ` · ${entry.source}` : ''}
                      </li>
                    );
                  })}
                </ul>
              }
            />
          ) : null}
          {catalog && catalog.profiles.length === 0 ? (
            <Typography.Text className='text-12px text-t-secondary'>{t(`${P}.empty`)}</Typography.Text>
          ) : null}
          {catalog?.profiles.map((entry) => (
            <div
              key={entry.ref.name}
              data-testid={`aelix-profile-${entry.ref.name}`}
              className='flex flex-col gap-6px rd-8px bg-fill-1 px-12px py-8px'
            >
              <div className='flex items-center justify-between gap-8px'>
                <div className='flex min-w-0 items-center gap-8px'>
                  <Typography.Text className='text-13px text-t-primary'>{entry.ref.name}</Typography.Text>
                  <Tag size='small'>{t(`${P}.scope.${entry.ref.scope}`)}</Tag>
                  <Typography.Text className='truncate text-12px text-t-secondary'>{entry.description}</Typography.Text>
                </div>
                <Button
                  size='mini'
                  type='text'
                  aria-label={t(`${P}.previewNamed`, { name: entry.ref.name })}
                  onClick={() => void inspect(entry.ref.name)}
                >
                  {t(`${P}.preview`)}
                </Button>
              </div>
              {preview?.name === entry.ref.name ? renderPreview(preview) : null}
            </div>
          ))}
          {catalog || (failure && failure.status !== 'unsupported') ? (
            <div className='flex justify-end'>
              <Button size='mini' disabled={loading} onClick={() => void load()}>
                {t('settings.aelixNative.reload')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default AelixProfiles;
