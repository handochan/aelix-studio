import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Divider, Input, Link, Select, Space, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { NativeAuthCatalog, NativeAuthCommand, NativeAuthOperation, NativeAuthSelection } from '@aionui/web-host';
import { ipcBridge } from '@/common';
import { requestNativeAuth } from './nativeAuth';

/** Reuses Provider settings while keeping native credentials outside Aion's Provider DB. */
export default function NativeProviders({
  onOpenConversation,
}: {
  onOpenConversation?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<NativeAuthCatalog>();
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [exclusive, setExclusive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<NativeAuthOperation>();
  const [value, setValue] = useState('');
  const [custom, setCustom] = useState(false);
  const [customProvider, setCustomProvider] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [api, setApi] = useState('openai-completions');
  const mounted = useRef(false);
  const currentOperation = useRef<NativeAuthOperation | undefined>(undefined);
  const selected = catalog?.providers.find((item) => item.id === provider);
  const pending = operation?.phase === 'pending';
  const disabled = busy || pending;

  const refresh = useCallback(async () => {
    const reply = await requestNativeAuth({ action: 'catalog' });
    if (!mounted.current) return;
    if (reply.ok && 'providers' in reply.data) {
      const next = reply.data;
      setCatalog(next);
      setProvider(
        (previous) =>
          previous || next.providers.find((item) => item.configured || item.source)?.id || next.providers[0]?.id || ''
      );
    } else if (reply.ok === false) setError(reply.code);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      const active = currentOperation.current;
      if (active?.phase === 'pending') void requestNativeAuth({ action: 'cancel', operationId: active.operationId });
    };
  }, [refresh]);

  useEffect(() => {
    setKey('');
    setValue('');
    setModel(selected?.models[0]?.id ?? '');
  }, [provider, selected?.models[0]?.id]);

  const perform = async (command: NativeAuthCommand): Promise<void> => {
    setBusy(true);
    setError('');
    const reply = await requestNativeAuth(command);
    if (!mounted.current) {
      if (reply.ok && 'operationId' in reply.data && reply.data.phase === 'pending') {
        void requestNativeAuth({ action: 'cancel', operationId: reply.data.operationId });
      }
      return;
    }
    if (reply.ok === false) {
      setError(reply.code);
      await refresh();
    } else if ('providers' in reply.data) {
      setCatalog(reply.data);
      if (command.action === 'endpoint') {
        setProvider(command.provider);
        setModel(command.model);
      }
    } else if ('operationId' in reply.data) {
      currentOperation.current = reply.data;
      setOperation(reply.data);
      if (reply.data.phase !== 'pending') await refresh();
    }
    setBusy(false);
  };

  useEffect(() => {
    if (!operation || operation.phase !== 'pending') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const reply = await requestNativeAuth({ action: 'poll', operationId: operation.operationId });
      if (stopped) return;
      if (
        currentOperation.current?.operationId === operation.operationId &&
        currentOperation.current.phase !== 'pending'
      )
        return;
      if (reply.ok && 'operationId' in reply.data) {
        currentOperation.current = reply.data;
        setOperation(reply.data);
        if (reply.data.phase !== 'pending') {
          setValue('');
          if (reply.data.phase === 'failed') setError(reply.data.code ?? 'NATIVE_FAILED');
          await refresh();
          return;
        }
      } else if (reply.ok === false) {
        setError(reply.code);
        // An ambiguous disconnect never resubmits the login or credential mutation.
        void requestNativeAuth({ action: 'cancel', operationId: operation.operationId });
        currentOperation.current = undefined;
        setOperation(undefined);
        await refresh();
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, 500);
    };
    timer = setTimeout(() => {
      void poll();
    }, 250);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [operation?.operationId, operation?.phase, refresh]);

  const startConversation = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const reply = await requestNativeAuth({ action: 'select', provider, model });
      if (reply.ok === false) {
        setError(reply.code);
        return;
      }
      if (!('command' in reply.data)) {
        setError('NATIVE_FAILED');
        return;
      }
      const launch: NativeAuthSelection = reply.data;
      const agents = await ipcBridge.acpConversation.getManagedAgents.invoke();
      let agent: { id: string } | undefined = agents.find(
        (item) =>
          item.command === launch.command &&
          JSON.stringify(item.args) === JSON.stringify(launch.args) &&
          JSON.stringify((item.env ?? []).map(({ name, value: entry }) => ({ name, value: entry }))) ===
            JSON.stringify(launch.env)
      );
      agent ??= await ipcBridge.acpConversation.createCustomAgent.invoke({
        name: `Aelix · ${provider}/${model}`,
        command: launch.command,
        args: launch.args,
        env: launch.env,
      });
      const assistants = await ipcBridge.assistants.list.invoke();
      const assistant = assistants.find((item) => item.agent_id === agent.id);
      if (!assistant) {
        setError('NATIVE_FAILED');
        return;
      }
      const conversation = await ipcBridge.conversation.create.invoke({
        name: `Aelix · ${provider}/${model}`,
        assistant: { id: assistant.id },
        extra: {},
      });
      onOpenConversation?.();
      void navigate(`/conversation/${conversation.id}`);
    } catch {
      setError('CONNECTION_LOST');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const errorText =
    error === 'CONFLICT'
      ? t('settings.nativeAuth.conflict')
      : error === 'RUNTIME_UNAVAILABLE'
        ? t('settings.nativeAuth.unavailable')
        : error === 'UNAUTHENTICATED'
          ? t('settings.nativeAuth.unauthenticated')
          : t('settings.nativeAuth.failed', { code: error });

  return (
    <section className='flex flex-col gap-12px mb-24px' data-testid='native-provider-settings'>
      <Typography.Title heading={6}>{t('settings.nativeAuth.title')}</Typography.Title>
      <Typography.Text type='secondary'>{t('settings.nativeAuth.description')}</Typography.Text>
      {error && <Alert type='error' content={errorText} />}
      {!catalog && (
        <Button
          disabled={disabled}
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          {t('settings.nativeAuth.refresh')}
        </Button>
      )}
      {catalog && (
        <>
          <Typography.Text copyable>{catalog.authPath}</Typography.Text>
          <Typography.Text type='secondary'>
            {t('settings.nativeAuth.modelsPath', { path: catalog.modelsPath })}
          </Typography.Text>
          <Select
            aria-label={t('settings.nativeAuth.provider')}
            value={provider}
            disabled={disabled}
            onChange={setProvider}
            options={catalog.providers.map((item) => ({ value: item.id, label: item.name }))}
            showSearch
          />
          <Typography.Text>
            {t('settings.nativeAuth.status', {
              configured: selected?.configured ? t('settings.nativeAuth.stored') : t('settings.nativeAuth.notStored'),
              source: selected?.source ?? t('settings.nativeAuth.noSource'),
            })}
          </Typography.Text>
          <Alert type='info' content={t('settings.nativeAuth.newSession')} />
          <Checkbox checked={exclusive} onChange={setExclusive} disabled={disabled}>
            {t('settings.nativeAuth.exclusive')}
          </Checkbox>
          <Space wrap>
            <Input.Password
              aria-label={t('settings.nativeAuth.key')}
              placeholder={t('settings.nativeAuth.key')}
              value={key}
              onChange={setKey}
              disabled={disabled}
              autoComplete='off'
            />
            <Button
              disabled={disabled || !exclusive || !key.trim()}
              onClick={() => {
                const secret = key;
                setKey('');
                void perform({ action: 'setKey', provider, key: secret, revision: catalog.revision, exclusive: true });
              }}
            >
              {t('settings.nativeAuth.saveKey')}
            </Button>
            <Button
              disabled={disabled || !exclusive || !selected?.oauth}
              onClick={() => {
                void perform({ action: 'login', provider, revision: catalog.revision, exclusive: true });
              }}
            >
              {t('settings.nativeAuth.oauth')}
            </Button>
            <Button
              disabled={disabled || !exclusive || !selected?.configured}
              onClick={() => {
                void perform({ action: 'logout', provider, revision: catalog.revision, exclusive: true });
              }}
            >
              {t('settings.nativeAuth.logout')}
            </Button>
            <Button
              disabled={disabled}
              onClick={() => {
                setError('');
                void refresh();
              }}
            >
              {t('settings.nativeAuth.refresh')}
            </Button>
          </Space>
          {pending && (
            <div className='flex flex-col gap-8px'>
              <Typography.Text>{t('settings.nativeAuth.pending')}</Typography.Text>
              {operation.authorization && (
                <>
                  <Link
                    href={operation.authorization.url}
                    target='_blank'
                    rel='noopener noreferrer'
                    referrerPolicy='no-referrer'
                  >
                    {t('settings.nativeAuth.openAuthorization')}
                  </Link>
                  <Typography.Text className='whitespace-pre-wrap'>
                    {operation.authorization.instructions}
                  </Typography.Text>
                </>
              )}
              {operation.prompt && (
                <>
                  <Typography.Text>
                    {operation.prompt.kind === 'manual'
                      ? t('settings.nativeAuth.manualCallback')
                      : operation.prompt.message}
                  </Typography.Text>
                  {operation.prompt.options ? (
                    <Select
                      aria-label={t('settings.nativeAuth.callback')}
                      value={value}
                      onChange={setValue}
                      options={operation.prompt.options.map((item) => ({ label: item.label, value: item.id }))}
                    />
                  ) : (
                    <Input.Password
                      aria-label={t('settings.nativeAuth.callback')}
                      value={value}
                      onChange={setValue}
                      autoComplete='off'
                    />
                  )}
                  <Button
                    disabled={busy || (!value && !operation.prompt.allowEmpty)}
                    onClick={() => {
                      if (!operation.prompt) return;
                      const answer = value;
                      setValue('');
                      void perform({
                        action: 'reply',
                        operationId: operation.operationId,
                        challengeId: operation.prompt.challengeId,
                        value: answer,
                      });
                    }}
                  >
                    {t('settings.nativeAuth.continue')}
                  </Button>
                </>
              )}
              <Button
                onClick={() => {
                  setValue('');
                  void perform({ action: 'cancel', operationId: operation.operationId });
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}
          <Select
            aria-label={t('settings.nativeAuth.model')}
            value={model}
            disabled={disabled}
            onChange={setModel}
            options={(selected?.models ?? []).map((item) => ({ value: item.id, label: item.name }))}
            showSearch
          />
          <Typography.Text type='secondary'>
            {selected?.models.find((item) => item.id === model)?.endpoint}
          </Typography.Text>
          <Button
            type='primary'
            disabled={disabled || !model || !selected?.source}
            onClick={() => {
              void startConversation();
            }}
          >
            {t('settings.nativeAuth.startConversation')}
          </Button>
          <Typography.Text type='secondary'>{t('settings.nativeAuth.firstResponse')}</Typography.Text>
          <Checkbox checked={custom} onChange={setCustom} disabled={disabled}>
            {t('settings.nativeAuth.customEndpoint')}
          </Checkbox>
          {custom && (
            <div className='flex flex-col gap-8px'>
              <Input
                aria-label={t('settings.nativeAuth.providerId')}
                placeholder={t('settings.nativeAuth.providerId')}
                value={customProvider}
                onChange={setCustomProvider}
                disabled={disabled}
              />
              <Input
                aria-label={t('settings.nativeAuth.model')}
                placeholder={t('settings.nativeAuth.model')}
                value={customModel}
                onChange={setCustomModel}
                disabled={disabled}
              />
              <Input
                aria-label={t('settings.nativeAuth.endpoint')}
                placeholder={t('settings.nativeAuth.endpoint')}
                value={endpoint}
                onChange={setEndpoint}
                disabled={disabled}
              />
              <Select
                aria-label={t('settings.nativeAuth.protocol')}
                value={api}
                onChange={setApi}
                disabled={disabled}
                options={[
                  { label: 'OpenAI', value: 'openai-completions' },
                  { label: 'Anthropic', value: 'anthropic-messages' },
                ]}
              />
              <Button
                disabled={disabled || !exclusive || !customProvider || !customModel || !endpoint}
                onClick={() => {
                  void perform({
                    action: 'endpoint',
                    provider: customProvider,
                    model: customModel,
                    endpoint,
                    api,
                    revision: catalog.revision,
                    exclusive: true,
                  });
                }}
              >
                {t('settings.nativeAuth.saveEndpoint')}
              </Button>
            </div>
          )}
        </>
      )}
      <Divider />
      <Typography.Text type='secondary'>{t('settings.nativeAuth.aionProviders')}</Typography.Text>
    </section>
  );
}
