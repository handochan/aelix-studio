/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Verifies MessageTips only renders the FeedbackButton on error tips and
 * wires it to module=conversation-session.
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type MockInstance } from 'vitest';
import { cleanup, render as renderComponent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import koConversation from '@renderer/services/i18n/locales/ko-KR/conversation.json';

const enConversation = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales/en-US/conversation.json'),
    'utf8'
  )
);
const enAcp = JSON.parse(
  readFileSync(path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales/en-US/acp.json'), 'utf8')
);

const i18nConfig = JSON.parse(
  readFileSync(path.join(process.cwd(), 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
) as { supportedLanguages: string[] };

const supportedLocaleNames = i18nConfig.supportedLanguages;

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: {
      'en-US': { translation: { conversation: enConversation, acp: enAcp } },
      'ko-KR': { translation: { conversation: koConversation } },
    },
    interpolation: { escapeValue: false },
  });
});

const render = (node: React.ReactNode) => renderComponent(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

const talkToButlerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/renderer/hooks/assistant/useTalkToButler', () => ({ useTalkToButler: () => talkToButlerMock }));

const openFeedbackMock = vi.fn(() => Promise.resolve());
vi.mock('@/renderer/hooks/context/FeedbackContext', () => ({
  useFeedback: () => ({ openFeedback: openFeedbackMock }),
}));

// CollapsibleContent uses ResizeObserver and runtime theme context — stub it
// so tests don't have to pull in the entire theme provider tree.
vi.mock('@renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// MarkdownView pulls in a heavy markdown pipeline — replace with a passthrough.
vi.mock('@renderer/components/Markdown', () => ({
  default: vi.fn(({ children }: { children: React.ReactNode }) => <div>{children}</div>),
}));

import MarkdownView from '@renderer/components/Markdown';
import MessageTips from '@/renderer/pages/conversation/Messages/components/MessageTips';
import { normalizeDbMessage } from '@/renderer/pages/conversation/Messages/hooks';
import type { AgentStreamErrorInfo, IMessageTips } from '@/common/chat/chatLib';
import { composeMessage, transformMessage } from '@/common/chat/chatLib';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import { buildSendFailureError } from '@/renderer/pages/conversation/platforms/acp/buildSendFailureError';
import { emitter } from '@/renderer/utils/emitter';
import { MemoryRouter, useLocation } from 'react-router-dom';

const requiredAgentErrorCodes = [
  'USER_AGENT_SESSION_LOCKED',
  'USER_AGENT_TURN_FAILED_AFTER_DISPATCH',
  'USER_AGENT_BUSY',
  'USER_AGENT_OPERATION_REFUSED',
  'AIONUI_CONVERSATION_BUSY',
  'USER_AGENT_HANDSHAKE_FAILED',
  'USER_AGENT_HANDSHAKE_TIMEOUT',
  'USER_AGENT_ACP_INIT_FAILED',
  'USER_AGENT_PROTOCOL_PARSE_ERROR',
  'USER_AGENT_INVALID_REQUEST',
  'USER_AGENT_RESOURCE_NOT_FOUND',
  'USER_AGENT_PROTOCOL_ERROR',
  'USER_AGENT_PROTOCOL_MISMATCH',
  'USER_AGENT_NO_PREVIOUS_SESSION',
  'USER_AGENT_OPENCLAW_GATEWAY_UNREACHABLE',
  'USER_AGENT_COMMAND_NOT_FOUND',
  'USER_AGENT_MISSING_ENV',
  'USER_LLM_PROVIDER_AWS_SSO_EXPIRED',
  'USER_LLM_PROVIDER_PERMISSION_DENIED',
  'USER_LLM_PROVIDER_BILLING_REQUIRED',
  'USER_LLM_PROVIDER_UNSUPPORTED_MODEL',
  'USER_LLM_PROVIDER_ENDPOINT_NOT_FOUND',
  'USER_LLM_PROVIDER_INVALID_REQUEST',
  'USER_LLM_PROVIDER_INVALID_TOOL_SCHEMA',
  'USER_LLM_PROVIDER_CONTEXT_TOO_LARGE',
  'USER_LLM_PROVIDER_EMPTY_RESPONSE',
] as const;

const requiredAgentTipCodes = [
  'ACP_EMPTY_TURN',
  'ACP_EMPTY_TURN_MAX_TOKENS',
  'ACP_EMPTY_TURN_MAX_TURN_REQUESTS',
  'ACP_EMPTY_TURN_REFUSAL',
] as const;

const buildTips = (
  type: IMessageTips['content']['type'],
  content = 'boom',
  error?: AgentStreamErrorInfo,
  extra?: Pick<IMessageTips['content'], 'code' | 'params'>
): IMessageTips =>
  ({
    id: 'tip-1',
    type: 'tips',
    content: { type, content, ...(error ? { error } : {}), ...extra },
  }) as IMessageTips;

describe('MessageTips — FeedbackButton wiring', () => {
  beforeEach(() => {
    openFeedbackMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render FeedbackButton on success tips', () => {
    render(<MessageTips message={buildTips('success')} />);
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('does not render FeedbackButton on warning tips', () => {
    render(<MessageTips message={buildTips('warning')} />);
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('does not render FeedbackButton on info tips', () => {
    render(<MessageTips message={buildTips('info')} />);
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('renders FeedbackButton when tip type is error', () => {
    render(<MessageTips message={buildTips('error')} />);
    expect(screen.getByText('settings.oneClickFeedback')).toBeInTheDocument();
  });

  it('click opens feedback with module=conversation-session', async () => {
    const user = userEvent.setup();
    render(<MessageTips message={buildTips('error')} />);
    await user.click(screen.getByText('settings.oneClickFeedback'));

    expect(openFeedbackMock).toHaveBeenCalledTimes(1);
    expect(openFeedbackMock).toHaveBeenCalledWith({
      module: 'conversation-session',
      autoScreenshot: true,
    });
  });

  it('renders FeedbackButton on JSON-formatted error content too', async () => {
    const user = userEvent.setup();
    render(<MessageTips message={buildTips('error', '{"code":500}')} />);
    await user.click(screen.getByText('settings.oneClickFeedback'));
    expect(openFeedbackMock).toHaveBeenCalledWith({
      module: 'conversation-session',
      autoScreenshot: true,
    });
  });

  it('click opens feedback with structured agent error metadata', async () => {
    const user = userEvent.setup();
    render(
      <MessageTips
        message={buildTips('error', 'raw provider 401', {
          message: 'raw provider 401',
          code: 'USER_LLM_PROVIDER_AUTH_FAILED',
          ownership: 'user_llm_provider',
          detail: 'Provider returned 401.',
          retryable: false,
          feedback_recommended: true,
          resolution: {
            kind: 'check_provider_credentials',
            target: 'provider_settings',
          },
        })}
      />
    );

    await user.click(screen.getByText('settings.oneClickFeedback'));

    expect(openFeedbackMock).toHaveBeenCalledWith({
      module: 'conversation-session',
      autoScreenshot: true,
      tags: {
        agent_error_code: 'USER_LLM_PROVIDER_AUTH_FAILED',
        agent_error_ownership: 'user_llm_provider',
        agent_error_retryable: 'false',
        agent_error_resolution: 'check_provider_credentials',
      },
      extra: {
        agent_error: {
          code: 'USER_LLM_PROVIDER_AUTH_FAILED',
          ownership: 'user_llm_provider',
          retryable: false,
          feedback_recommended: true,
          resolution: {
            kind: 'check_provider_credentials',
            target: 'provider_settings',
          },
        },
      },
    });
  });

  it('hides FeedbackButton but keeps ButlerDiagnoseButton when structured error opts out of feedback', () => {
    render(
      <MessageTips
        message={buildTips('error', 'raw provider 401', {
          message: 'raw provider 401',
          code: 'USER_LLM_PROVIDER_AUTH_FAILED',
          ownership: 'user_llm_provider',
          detail: 'Provider returned 401.',
          retryable: false,
          feedback_recommended: false,
          resolution: {
            kind: 'check_provider_credentials',
            target: 'provider_settings',
          },
        })}
      />
    );

    // User-environment errors don't funnel to the report modal…
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
    // …but the Butler chip stays: these are exactly what it diagnoses best.
    expect(screen.getByText('settings.talkToButler.solveWithButler')).toBeInTheDocument();
  });

  it('carries the rawError diagnostic summary into the feedback extra for internal errors', async () => {
    const user = userEvent.setup();
    render(
      <MessageTips
        message={buildTips('error', 'Something went wrong, please try again.', {
          message: 'Something went wrong, please try again.',
          code: 'AIONUI_INTERNAL_ERROR',
          ownership: 'aionui',
          detail: 'Something went wrong, please try again.',
          retryable: true,
          feedback_recommended: true,
          rawError: {
            name: 'Error',
            message: 'connect ECONNREFUSED 127.0.0.1:8080',
            code: 'ECONNREFUSED',
            stack: 'Error: connect ECONNREFUSED\n    at frame',
          },
        })}
      />
    );

    await user.click(screen.getByText('settings.oneClickFeedback'));

    const call = openFeedbackMock.mock.calls[0][0] as { extra: { agent_error: { rawError?: unknown } } };
    expect(call.extra.agent_error.rawError).toEqual({
      name: 'Error',
      message: 'connect ECONNREFUSED 127.0.0.1:8080',
      code: 'ECONNREFUSED',
      stack: 'Error: connect ECONNREFUSED\n    at frame',
    });
  });

  it('renders HTML-like error text as literal text', () => {
    const { container } = render(<MessageTips message={buildTips('error', '<strong>boom</strong>')} />);

    expect(container.querySelector('strong')).not.toBeInTheDocument();
    expect(screen.getByText('<strong>boom</strong>')).toBeInTheDocument();
  });

  it('renders localized info tips as plain text without icon or feedback', () => {
    const { container } = render(
      <MessageTips
        message={buildTips('info', '', undefined, {
          code: 'ACP_EMPTY_TURN',
          params: { provider: 'OpenCode' },
        })}
      />
    );

    expect(screen.getByText('This request produced no visible reply.')).toBeInTheDocument();
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('renders the same localized copy for command empty turns', () => {
    render(
      <MessageTips
        message={buildTips('info', '', undefined, {
          code: 'ACP_EMPTY_TURN',
        })}
      />
    );

    expect(screen.getByText('This request produced no visible reply.')).toBeInTheDocument();
  });

  it('renders localized warning tips from code-only payloads', () => {
    render(
      <MessageTips
        message={buildTips('warning', '', undefined, {
          code: 'ACP_EMPTY_TURN_MAX_TOKENS',
        })}
      />
    );

    expect(
      screen.getByText("This request hit the model's output token limit before any visible reply was produced.")
    ).toBeInTheDocument();
  });

  it('renders classified provider errors with friendly copy and feedback', () => {
    render(
      <MessageTips
        message={buildTips('error', 'raw provider 401', {
          message: 'raw provider 401',
          code: 'USER_LLM_PROVIDER_AUTH_FAILED',
          ownership: 'user_llm_provider',
          detail: 'Provider returned 401.',
          retryable: false,
          feedback_recommended: false,
        })}
      />
    );

    expect(screen.getByText('Model provider authentication failed')).toBeInTheDocument();
    expect(screen.getByText(/rejected the API key or account credentials/)).toBeInTheDocument();
    expect(screen.getByText('Model provider')).toBeInTheDocument();
    expect(screen.getByText('Needs configuration')).toBeInTheDocument();
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('renders AWS SSO provider auth code as localized user guidance', () => {
    render(
      <MessageTips
        message={buildTips('error', 'The model provider rejected the request', {
          message: 'The model provider rejected the request',
          code: 'USER_LLM_PROVIDER_AWS_SSO_EXPIRED',
          ownership: 'user_llm_provider',
          retryable: false,
          feedback_recommended: false,
          resolution: {
            kind: 'check_provider_credentials',
            target: 'provider_settings',
          },
        })}
      />
    );

    expect(
      screen.getByText(
        "Your AWS SSO session has expired. Run 'aws sso login' for the matching profile, then send the message again."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('renders structured error resolution guidance', () => {
    render(
      <MessageTips
        message={buildTips('error', 'raw provider billing error', {
          message: 'raw provider billing error',
          code: 'USER_LLM_PROVIDER_BILLING_REQUIRED',
          ownership: 'user_llm_provider',
          detail: 'Provider billing limit exceeded.',
          retryable: false,
          feedback_recommended: false,
          resolution: {
            kind: 'check_provider_billing',
            target: 'provider_settings',
          },
        })}
      />
    );

    expect(screen.getByText('Suggestion: Check the model provider balance, credits, or quota.')).toBeInTheDocument();
  });

  it('renders billing-required provider errors from i18n instead of backend fallback text', () => {
    render(
      <MessageTips
        message={buildTips('error', 'backend billing required fallback', {
          message: 'backend billing required fallback',
          code: 'USER_LLM_PROVIDER_BILLING_REQUIRED',
          ownership: 'user_llm_provider',
          detail: 'Provider billing check failed.',
          retryable: false,
          feedback_recommended: false,
        })}
      />
    );

    expect(screen.getByText('Model provider billing is required')).toBeInTheDocument();
    expect(screen.getByText(/needs active billing, credits, or quota/)).toBeInTheDocument();
    expect(screen.queryByText('backend billing required fallback')).not.toBeInTheDocument();
  });

  it('renders OpenClaw Gateway unreachable errors with localized recovery guidance', () => {
    render(
      <MessageTips
        message={buildTips('error', 'backend fallback should not be primary copy', {
          message: 'OpenClaw Gateway is not reachable',
          code: 'USER_AGENT_OPENCLAW_GATEWAY_UNREACHABLE',
          ownership: 'user_agent',
          detail:
            'OpenClaw Gateway is not running or cannot be reached at 127.0.0.1:18789.\n\nStart OpenClaw Gateway and try again. You can run:\nopenclaw gateway status\nopenclaw gateway start',
          retryable: true,
          feedback_recommended: false,
          resolution: {
            kind: 'check_agent_installation',
            target: 'agent_settings',
          },
        })}
      />
    );

    expect(screen.getByText('OpenClaw Gateway is not reachable')).toBeInTheDocument();
    expect(screen.getAllByText(/OpenClaw Gateway is not running/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/openclaw gateway status/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/openclaw gateway start/).length).toBeGreaterThan(0);
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Retryable')).toBeInTheDocument();
    expect(
      screen.getByText('Suggestion: Check the agent installation and local command configuration.')
    ).toBeInTheDocument();
    expect(screen.queryByText('backend fallback should not be primary copy')).not.toBeInTheDocument();
  });

  it('keeps generic startup failures on the existing startup copy', () => {
    render(
      <MessageTips
        message={buildTips('error', 'backend startup fallback', {
          message: 'Agent process exited before initialize handshake completed',
          code: 'USER_AGENT_STARTUP_FAILED',
          ownership: 'user_agent',
          detail: 'Agent process exited before initialize handshake completed (exit code 1)',
          retryable: true,
          feedback_recommended: false,
          resolution: {
            kind: 'check_agent_installation',
            target: 'agent_settings',
          },
        })}
      />
    );

    expect(screen.getByText('The selected agent failed to start')).toBeInTheDocument();
    expect(screen.queryByText('OpenClaw Gateway is not reachable')).not.toBeInTheDocument();
    expect(screen.queryByText(/openclaw gateway start/)).not.toBeInTheDocument();
  });

  it('renders ACP protocol errors with agent attribution and technical details only', () => {
    render(
      <MessageTips
        message={buildTips('error', 'backend protocol fallback', {
          message: 'Agent protocol parse error',
          code: 'USER_AGENT_PROTOCOL_PARSE_ERROR',
          ownership: 'user_agent',
          detail: 'Agent protocol parse error: Parse error',
          retryable: false,
          feedback_recommended: false,
        })}
      />
    );

    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Agent reported a protocol parse error')).toBeInTheDocument();
    expect(screen.getByText(/reported that an ACP\/JSON-RPC message could not be parsed/)).toBeInTheDocument();
    expect(screen.queryByText(/Suggestion:/)).not.toBeInTheDocument();
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
    expect(screen.getByText(/USER_AGENT_PROTOCOL_PARSE_ERROR/)).toBeInTheDocument();
    expect(screen.queryByText('backend protocol fallback')).not.toBeInTheDocument();
  });

  it('expands classified error technical details by default', () => {
    render(
      <MessageTips
        message={buildTips('error', 'raw provider 401', {
          message: 'raw provider 401',
          code: 'USER_LLM_PROVIDER_AUTH_FAILED',
          ownership: 'user_llm_provider',
          detail: 'Provider returned 401.',
          retryable: false,
          feedback_recommended: false,
        })}
      />
    );

    const detailsToggle = screen.getByRole('button', { name: /common.technical_details/ });
    expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Provider returned 401/)).toBeInTheDocument();
  });
});

describe('agent error locale copy', () => {
  it('defines empty-turn info tip copy in every locale', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

    for (const localeName of supportedLocaleNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));

      for (const code of requiredAgentTipCodes) {
        expect(locale.agentTip.codes[code]?.body, `${localeName} ${code} body`).toEqual(expect.any(String));
        expect(locale.agentTip.codes[code]?.body.trim(), `${localeName} ${code} body`).not.toBe('');
      }
    }
  });

  it('defines title and body copy for newly classified agent error codes in every locale', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

    for (const localeName of supportedLocaleNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));

      expect(locale.agentError.resolutionPrefix, `${localeName} resolution prefix`).toEqual(expect.any(String));
      expect(locale.agentError.resolutionPrefix.trim(), `${localeName} resolution prefix`).not.toBe('');

      for (const code of requiredAgentErrorCodes) {
        expect(locale.agentError.codes[code]?.title, `${localeName} ${code} title`).toEqual(expect.any(String));
        expect(locale.agentError.codes[code]?.title.trim(), `${localeName} ${code} title`).not.toBe('');
        expect(locale.agentError.codes[code]?.body, `${localeName} ${code} body`).toEqual(expect.any(String));
        expect(locale.agentError.codes[code]?.body.trim(), `${localeName} ${code} body`).not.toBe('');
      }
    }
  });

  it('keeps agent error copy localized outside English and Chinese locales', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');
    const localeNames = supportedLocaleNames.filter((localeName) => !['en-US', 'zh-CN', 'zh-TW'].includes(localeName));

    for (const localeName of localeNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));
      const agentError = locale.agentError;

      expect(agentError.fallbackTitle, localeName).not.toBe('The agent could not reply');
      expect(agentError.errorCode, localeName).not.toBe('Error code');
      expect(agentError.resolutionPrefix, localeName).not.toBe('Suggestion: ');
      expect(agentError.codes.USER_AGENT_ACP_INIT_FAILED.title, localeName).not.toBe(
        'Agent protocol initialization failed'
      );
      expect(agentError.codes.USER_LLM_PROVIDER_BILLING_REQUIRED.title, localeName).not.toBe(
        'Model provider billing is required'
      );
    }
  });

  it('does not label app-side errors as direct AionUi ownership', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

    for (const localeName of supportedLocaleNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));
      const agentError = locale.agentError;

      expect(agentError.ownership.aionui, localeName).not.toMatch(/AionUi/);

      for (const [code, copy] of Object.entries<Record<string, string>>(agentError.codes)) {
        if (!code.startsWith('AIONUI_')) continue;

        expect(copy.title, `${localeName} ${code} title`).not.toMatch(/AionUi/);
        expect(copy.body, `${localeName} ${code} body`).not.toMatch(/AionUi/);
      }
    }
  });

  it('does not describe ACP protocol fallback errors as app recognition bugs', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

    for (const localeName of supportedLocaleNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));
      const body = locale.agentError.codes.USER_AGENT_PROTOCOL_ERROR.body;

      expect(body, `${localeName} USER_AGENT_PROTOCOL_ERROR body`).not.toMatch(/app does not recognize/i);
      expect(body, `${localeName} USER_AGENT_PROTOCOL_ERROR body`).not.toMatch(/应用暂未识别/);
      expect(body, `${localeName} USER_AGENT_PROTOCOL_ERROR body`).not.toMatch(/應用暫未識別/);
    }
  });

  it('does not add speculative remediation to ACP protocol error copy', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');
    const protocolCodes = [
      'USER_AGENT_SESSION_NOT_FOUND',
      'USER_AGENT_UNSUPPORTED_METHOD',
      'USER_AGENT_INVALID_PARAMS',
      'USER_AGENT_ACP_INIT_FAILED',
      'USER_AGENT_PROTOCOL_PARSE_ERROR',
      'USER_AGENT_INVALID_REQUEST',
      'USER_AGENT_RESOURCE_NOT_FOUND',
      'USER_AGENT_PROTOCOL_ERROR',
      'USER_AGENT_PROTOCOL_MISMATCH',
    ];
    const speculativeFragments = [
      /update/i,
      /switch/i,
      /reconnect/i,
      /feedback/i,
      /technical detail/i,
      /升级/,
      /切换/,
      /重新连接/,
      /重连/,
      /反馈/,
      /技术详情/,
      /技術詳情/,
      /回饋/,
    ];

    for (const localeName of ['en-US', 'zh-CN', 'zh-TW']) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));

      for (const code of protocolCodes) {
        const copy = locale.agentError.codes[code];
        const text = `${copy.title}\n${copy.body}`;

        for (const fragment of speculativeFragments) {
          expect(text, `${localeName} ${code}`).not.toMatch(fragment);
        }
      }
    }
  });
});

describe('host ACP application error display', () => {
  afterEach(cleanup);
  it.each([
    ['USER_AGENT_SESSION_LOCKED', { lockedBy: 'native' }, 'CLI or another Aelix process'],
    ['USER_AGENT_SESSION_LOCKED', { lockedBy: 'acp' }, 'another Studio window'],
    ['USER_AGENT_SESSION_LOCKED', undefined, 'lock is released'],
    ['USER_AGENT_TURN_FAILED_AFTER_DISPATCH', undefined, 'may already have run'],
    ['USER_AGENT_BUSY', undefined, 'cancel it before continuing'],
    [
      'USER_AGENT_BUSY',
      { kind: 'studio_extension_management_required', action: 'install' },
      'cancel it before continuing',
    ],
    ['USER_AGENT_OPERATION_REFUSED', { kind: 'restrictions_unenforceable', methods: ['tools/write'] }, 'tools/write'],
    ['USER_AGENT_OPERATION_REFUSED', { kind: 'profile_unavailable', profile: 'team' }, 'Restore the profile'],
    ['USER_AGENT_OPERATION_REFUSED', { kind: 'extension_owned_by_launch', source: '/operator/extension' }, 'extension'],
    ['USER_AGENT_OPERATION_REFUSED', { kind: 'runtime_control_required' }, 'runtime controls'],
    ['USER_AGENT_OPERATION_REFUSED', { kind: 'client_action_required' }, 'requested action in Studio'],
    [
      'USER_AGENT_OPERATION_REFUSED',
      { kind: 'studio_extension_management_required', action: 'install' },
      '^Install extensions from the Extensions screen\\.$',
    ],
    [
      'USER_AGENT_OPERATION_REFUSED',
      { kind: 'studio_extension_management_required', action: 'update' },
      '^Update extensions from the Extensions screen\\.$',
    ],
    [
      'USER_AGENT_OPERATION_REFUSED',
      { kind: 'studio_extension_management_required', action: 'remove' },
      '^Remove extensions from the Extensions screen\\.$',
    ],
    ['USER_AGENT_OPERATION_REFUSED', { kind: 'future_kind', action: 'install' }, 'agent refused this operation'],
    ['USER_AGENT_OPERATION_REFUSED', null, 'agent refused this operation'],
  ])('renders %s with its specific explanation', (code, data, expected) => {
    render(
      <MessageTips
        message={buildTips('error', 'failure', {
          message: 'upstream failure',
          code,
          data,
          protocol_code: -32004,
          retryable: false,
          detail: 'ACP original detail',
        })}
      />
    );
    expect(screen.getByText(new RegExp(expected as string))).toBeInTheDocument();
    expect(screen.getByText(/ACP: -32004/)).toHaveTextContent('ACP original detail');
    expect(screen.queryByRole('button', { name: /retry|reconnect/i })).not.toBeInTheDocument();
  });
  it.each([
    { kind: 'restrictions_unenforceable' },
    { kind: 'profile_unavailable' },
    { kind: 'extension_owned_by_launch' },
    { kind: 'restrictions_unenforceable', methods: [] },
    { kind: 'restrictions_unenforceable', methods: ['', '  ', null] },
    { kind: 'profile_unavailable', profile: ' ' },
    { kind: 'extension_owned_by_launch', source: '' },
    { kind: 'extension_owned_by_launch', source: '/' },
    { kind: 'studio_extension_management_required' },
    { kind: 'studio_extension_management_required', action: 'verify' },
  ])('uses the generic refusal body when context is empty: $kind', (data) => {
    render(
      <MessageTips
        message={buildTips('error', 'failure', {
          code: 'USER_AGENT_OPERATION_REFUSED',
          message: 'upstream',
          data,
          workspacePath: '/workspace',
        })}
      />
    );
    expect(screen.getByText(enConversation.agentError.codes.USER_AGENT_OPERATION_REFUSED.body)).toBeInTheDocument();
  });
  it.each(['/private/operator/extension.py', String.raw`C:\private\operator\extension.py`])(
    'shows only a source basename in the body and Butler prompt: %s',
    async (source) => {
      talkToButlerMock.mockClear();
      const message = buildTips('error', 'failure', {
        code: 'USER_AGENT_OPERATION_REFUSED',
        message: `Launch owns ${source}`,
        detail: JSON.stringify({ source }),
        data: { kind: 'extension_owned_by_launch', source },
      });
      const before = JSON.stringify(message);
      const { container } = render(<MessageTips message={message} />);
      expect(container.textContent).not.toContain(source);
      await userEvent.click(screen.getByRole('button', { name: 'settings.talkToButler.solveWithButler' }));
      const prompt = talkToButlerMock.mock.calls[0][0].prompt as string;
      expect(prompt).toContain('extension.py');
      expect(prompt).not.toContain(source);
      expect(prompt).not.toContain(JSON.stringify(source).slice(1, -1));
      expect(JSON.stringify(message)).toBe(before);
    }
  );
  it('renders the host MCP reason as a warning without a retry action', () => {
    render(
      <MessageTips
        message={buildTips('warning', "MCP server 'blocked': OUTBOUND_DISABLED", undefined, {
          code: 'MCP_SERVER_UNAVAILABLE',
          params: { server_id: 'blocked' },
        })}
      />
    );
    expect(screen.getByText("MCP server 'blocked': OUTBOUND_DISABLED")).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('live MCP warning replacement', () => {
  afterEach(cleanup);
  it('updates one visible card while retaining a different server warning', () => {
    const notice = (server: string, reason: string) =>
      transformMessage({
        type: 'tips',
        conversation_id: 'c',
        msg_id: reason + server,
        data: {
          content: `${server}: ${reason}`,
          severity: 'warning',
          code: 'MCP_SERVER_UNAVAILABLE',
          params: { server_id: server },
          supersedes_key: `mcp-unavailable:${server}`,
        },
      }) as IMessageTips;
    let list = composeMessage(notice('one', 'old reason'), []);
    list = composeMessage(notice('two', 'other reason'), list);
    list = composeMessage(notice('one', 'new reason'), list);
    render(
      <>
        {list.map((item) => (
          <MessageTips key={item.id} message={item as IMessageTips} />
        ))}
      </>
    );
    expect(screen.queryByText('one: old reason')).not.toBeInTheDocument();
    expect(screen.getByText('one: new reason')).toBeInTheDocument();
    expect(screen.getByText('two: other reason')).toBeInTheDocument();
  });
});

const mcpWarning = (content: string, params?: IMessageTips['content']['params']): IMessageTips['content'] => ({
  content,
  type: 'warning',
  code: 'MCP_SERVER_UNAVAILABLE',
  ...(params ? { params } : {}),
});

describe.each(['live', 'history', 'serialized history'] as const)('MCP warning text from %s', (source) => {
  beforeEach(async () => {
    vi.mocked(MarkdownView).mockClear();
    await i18n.changeLanguage('ko-KR');
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en-US');
  });

  const renderWarning = (tip: IMessageTips['content']) => {
    const metadata = { type: 'tips' as const, conversation_id: 'conversation-1', msg_id: 'tip-1' };
    // The realtime bridge removes the message.stream envelope before transformation.
    const message =
      source === 'live'
        ? transformMessage({ ...metadata, data: tip })
        : normalizeDbMessage({
            ...metadata,
            id: 'tip-1',
            content: source === 'history' ? tip : JSON.stringify(tip),
          } as IMessageTips);
    if (message?.type !== 'tips') throw new Error('Expected an MCP warning tip');
    const result = render(<MessageTips message={message} />);
    expect(MarkdownView).not.toHaveBeenCalled();
    return result;
  };

  it('localizes unavailable MCP settings without the host’s placeholder server name', () => {
    renderWarning(
      mcpWarning('Could not load the MCP settings.', {
        reason_code: 'configuration_unavailable',
        server_id: '',
        server_name: 'Configured MCP servers',
      })
    );
    expect(screen.getByText('MCP 설정을 불러오지 못했습니다.')).toBeInTheDocument();
  });

  it('localizes an invalid transport from a session snapshot using its server name', () => {
    renderWarning(
      mcpWarning("MCP server '문서 검색': server configuration is invalid", {
        reason_code: 'invalid_configuration',
        server_id: 'snapshot-mcp-1',
        server_name: '문서 검색',
      })
    );
    expect(screen.getByText('MCP 서버 ‘문서 검색’의 연결 설정이 올바르지 않습니다.')).toBeInTheDocument();
  });

  it('localizes a runtime preparation failure using the server name as literal text', () => {
    const serverName = '<strong>Files & tools</strong>';
    const { container } = renderWarning(
      mcpWarning('Could not prepare the configured runtime.', {
        reason_code: 'runtime_unavailable',
        server_id: 'files',
        server_name: serverName,
      })
    );
    expect(
      screen.getByText(`MCP 서버 ‘${serverName}’의 명령 또는 실행 환경을 준비하지 못했습니다.`)
    ).toBeInTheDocument();
    expect(container.querySelector('strong')).not.toBeInTheDocument();
  });

  it.each([
    ['invalid_configuration', 'MCP 서버의 연결 설정이 올바르지 않습니다.'],
    ['runtime_unavailable', 'MCP 서버의 명령 또는 실행 환경을 준비하지 못했습니다.'],
  ])('localizes %s when the server is unnamed', (reason_code, expected) => {
    renderWarning(mcpWarning('The MCP server is unavailable.', { reason_code, server_id: '', server_name: '' }));
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it.each([
    ['an unknown reason code', { reason_code: 'future_reason', server_name: 'Files' }],
    ['an old tip without a reason code', { server_id: 'files' }],
    ['a tip without params', undefined],
  ] as const)('shows the original English content for %s', (_scenario, params) => {
    const content = "MCP server '<strong>{{server_name}}</strong>': unavailable";
    const { container } = renderWarning(mcpWarning(content, params));
    expect(screen.getByText(content)).toBeInTheDocument();
    expect(container.querySelector('strong')).not.toBeInTheDocument();
  });

  it('shows JSON-shaped fallback content as plain text', () => {
    const content = '{"message":"MCP server unavailable"}';
    renderWarning(mcpWarning(content));
    expect(screen.getByText(content)).toBeInTheDocument();
  });
});

// Host bodies from aelix-studio-host #77 (model refusal) and #82 (provider cause).
const MODEL_REFUSAL_MESSAGE = 'The Agent cannot perform this operation';
const TURN_FAILED_MESSAGE = 'The turn failed after the Agent accepted it';
const modelSelectionData = (availableModels: unknown = 2) => ({
  kind: 'model_selection_required',
  configId: 'model',
  availableModels,
  retryable: false,
});
const modelRefusal = (data: unknown = modelSelectionData(), protocol_code = -32004): AgentStreamErrorInfo => ({
  message: MODEL_REFUSAL_MESSAGE,
  protocol_code,
  data,
  code: 'USER_AGENT_OPERATION_REFUSED',
  ownership: 'user_agent',
  detail: 'ACP request failed',
  retryable: false,
  feedback_recommended: false,
});
const providerFailureData = (cause: unknown) => ({ kind: 'turn_failed_after_dispatch', retryable: false, cause });
const providerFailure = (
  data: unknown = providerFailureData({ kind: 'provider_auth', retryable: false }),
  protocol_code = -33002
): AgentStreamErrorInfo => ({
  message: TURN_FAILED_MESSAGE,
  protocol_code,
  data,
  code: 'USER_AGENT_TURN_FAILED_AFTER_DISPATCH',
  ownership: 'user_agent',
  detail: 'ACP request failed',
  retryable: false,
  feedback_recommended: false,
});
const aelixTip = (error: AgentStreamErrorInfo, content = error.message): IMessageTips =>
  ({
    id: 'aelix-tip',
    type: 'tips',
    conversation_id: 'conv-1',
    content: { type: 'error', content, error },
  }) as IMessageTips;

const LocationProbe = () => <div data-testid='location'>{useLocation().pathname}</div>;
const renderGuidance = (message: IMessageTips) =>
  render(
    <MemoryRouter initialEntries={['/conversation/conv-1']}>
      <MessageTips message={message} />
      <LocationProbe />
    </MemoryRouter>
  );

const refusedCopy = enConversation.agentError.codes.USER_AGENT_OPERATION_REFUSED;
const turnFailedCopy = enConversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH;
const actionCopy = enConversation.agentError.actions;
const guidanceActionName = new RegExp(`^(${actionCopy.chooseModel}|${actionCopy.openModelSettings})$`);

describe('builtin Aelix error guidance', () => {
  let emitSpy: MockInstance<typeof emitter.emit>;
  beforeEach(() => {
    emitSpy = vi.spyOn(emitter, 'emit');
  });
  afterEach(() => {
    emitSpy.mockRestore();
    cleanup();
  });

  it('asks for a model and offers the conversation model picker', () => {
    renderGuidance(aelixTip(modelRefusal()));
    expect(screen.getByText(refusedCopy.modelSelectionRequired.title)).toBeInTheDocument();
    expect(screen.getByText(refusedCopy.modelSelectionRequired.body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: actionCopy.chooseModel })).toBeInTheDocument();
  });

  it('opens only the model picker of this conversation and does not resend or navigate', async () => {
    renderGuidance(aelixTip(modelRefusal()));
    await userEvent.click(screen.getByRole('button', { name: actionCopy.chooseModel }));
    expect(emitSpy.mock.calls).toEqual([['acp.model.selector.open', 'conv-1']]);
    expect(screen.getByTestId('location')).toHaveTextContent('/conversation/conv-1');
  });

  it('points to model settings instead of the picker when no models are available', async () => {
    renderGuidance(aelixTip(modelRefusal(modelSelectionData(0))));
    expect(screen.getByText(refusedCopy.modelSelectionRequired.noModelsTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: actionCopy.chooseModel })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: actionCopy.openModelSettings }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/model');
  });

  it('offers no picker action when the tip has no conversation to target', () => {
    const tip = aelixTip(modelRefusal());
    renderGuidance({ ...tip, conversation_id: '' });
    expect(screen.getByText(refusedCopy.modelSelectionRequired.title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: guidanceActionName })).not.toBeInTheDocument();
  });

  it.each([
    ['provider_auth', turnFailedCopy.causes.providerAuth, actionCopy.openModelSettings],
    ['provider_bad_request', turnFailedCopy.causes.providerBadRequest, actionCopy.openModelSettings],
    ['provider_rate_limit', turnFailedCopy.causes.providerRateLimit, undefined],
    ['provider_unavailable', turnFailedCopy.causes.providerUnavailable, undefined],
    ['provider_network', turnFailedCopy.causes.providerNetwork, undefined],
  ])('explains %s as a provider problem with the right next step', (kind, copy, action) => {
    renderGuidance(aelixTip(providerFailure(providerFailureData({ kind, retryable: false }))));
    expect(screen.getByText(copy.title)).toBeInTheDocument();
    expect(screen.getByText(copy.body)).toBeInTheDocument();
    const actionButton = screen.queryByRole('button', { name: guidanceActionName });
    expect(actionButton?.textContent ?? undefined).toBe(action);
  });

  it('labels provider causes as model provider problems without the "Needs configuration" tag', () => {
    renderGuidance(aelixTip(providerFailure(providerFailureData({ kind: 'provider_rate_limit', retryable: false }))));
    expect(screen.getByText(enConversation.agentError.ownership.user_llm_provider)).toBeInTheDocument();
    expect(screen.queryByText(enConversation.agentError.notRetryable)).not.toBeInTheDocument();
  });

  it('opens provider settings for a rejected API key without resending', async () => {
    renderGuidance(aelixTip(providerFailure()));
    await userEvent.click(screen.getByRole('button', { name: actionCopy.openModelSettings }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/model');
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('keeps the generic dispatch failure text for an unknown cause', () => {
    renderGuidance(aelixTip(providerFailure(providerFailureData({ kind: 'unknown', retryable: false }))));
    expect(screen.getByText(turnFailedCopy.title)).toBeInTheDocument();
    expect(screen.getByText(turnFailedCopy.body)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: guidanceActionName })).not.toBeInTheDocument();
  });

  it.each([
    ['an extra field', { ...modelSelectionData(), extra: true }],
    ['a missing field', { kind: 'model_selection_required', configId: 'model', availableModels: 2 }],
    ['a negative count', modelSelectionData(-1)],
    ['a fractional count', modelSelectionData(1.5)],
    ['a string count', modelSelectionData('2')],
    ['a count above u32', modelSelectionData(2 ** 32)],
    ['another config id', { ...modelSelectionData(), configId: 'mode' }],
    ['retryable true', { ...modelSelectionData(), retryable: true }],
    ['null data', null],
    ['array data', [modelSelectionData()]],
  ])('falls back to the generic refusal card for model refusal data with %s', (_case, data) => {
    renderGuidance(aelixTip(modelRefusal(data)));
    expect(screen.getByText(refusedCopy.title)).toBeInTheDocument();
    expect(screen.getByText(refusedCopy.body)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: guidanceActionName })).not.toBeInTheDocument();
  });

  it('falls back to the generic refusal card when the model refusal has another protocol code', () => {
    renderGuidance(aelixTip(modelRefusal(modelSelectionData(), -32000)));
    expect(screen.getByText(refusedCopy.title)).toBeInTheDocument();
    expect(screen.queryByText(refusedCopy.modelSelectionRequired.title)).not.toBeInTheDocument();
  });

  it.each([
    ['an unlisted cause', providerFailureData({ kind: 'provider_quota', retryable: false })],
    ['a retryable cause', providerFailureData({ kind: 'provider_auth', retryable: true })],
    ['an extra cause field', providerFailureData({ kind: 'provider_auth', retryable: false, message: 'peer' })],
    ['a non-object cause', providerFailureData('provider_auth')],
    ['no cause', { kind: 'turn_failed_after_dispatch', retryable: false }],
    ['a retryable turn', { ...providerFailureData({ kind: 'provider_auth', retryable: false }), retryable: true }],
    ['another outer kind', { ...providerFailureData({ kind: 'provider_auth', retryable: false }), kind: 'other' }],
    ['an extra outer field', { ...providerFailureData({ kind: 'provider_auth', retryable: false }), extra: 1 }],
  ])('falls back to the generic dispatch failure card for provider data with %s', (_case, data) => {
    renderGuidance(aelixTip(providerFailure(data)));
    expect(screen.getByText(turnFailedCopy.title)).toBeInTheDocument();
    expect(screen.getByText(turnFailedCopy.body)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: guidanceActionName })).not.toBeInTheDocument();
  });

  it('falls back to the generic dispatch failure card when the provider failure has another protocol code', () => {
    renderGuidance(aelixTip(providerFailure(undefined, -32603)));
    expect(screen.getByText(turnFailedCopy.title)).toBeInTheDocument();
    expect(screen.queryByText(turnFailedCopy.causes.providerAuth.title)).not.toBeInTheDocument();
  });

  it.each([
    ['model refusal', modelRefusal()],
    ['provider failure', providerFailure()],
  ])('never shows peer text for a guided %s', (_case, error) => {
    const peerText = 'PEER TEXT sk-live-1234';
    const { container } = renderGuidance(aelixTip({ ...error, message: peerText }, peerText));
    expect(container.textContent).not.toContain(peerText);
  });
});

describe.each(['live stream', 'history row', 'serialized history row', 'HTTP send failure'] as const)(
  'builtin Aelix guidance from a %s',
  (source) => {
    afterEach(cleanup);

    // Each source carries the same host error object in its own envelope.
    const tipFrom = (error: AgentStreamErrorInfo): IMessageTips => {
      const metadata = { type: 'tips' as const, conversation_id: 'conv-1', msg_id: 'msg-1' };
      const tipContent = { content: error.message, type: 'error' as const, error };
      let message: unknown;
      if (source === 'live stream') {
        message = transformMessage({ type: 'error', conversation_id: 'conv-1', msg_id: 'msg-1', data: error });
      } else if (source === 'HTTP send failure') {
        const httpError = new BackendHttpError({
          method: 'POST',
          path: '/api/conversations/conv-1/messages',
          status: 502,
          body: { success: false, code: error.code, error: error.message, details: error },
        });
        message = {
          ...metadata,
          id: 'send-failure',
          content: { ...tipContent, error: buildSendFailureError(httpError, error.message) },
        };
      } else {
        message = normalizeDbMessage({
          ...metadata,
          id: 'history-tip',
          content: source === 'history row' ? tipContent : JSON.stringify(tipContent),
        } as IMessageTips);
      }
      if ((message as IMessageTips | undefined)?.type !== 'tips') throw new Error('Expected an error tip');
      return message as IMessageTips;
    };

    it('shows the model selection guidance', () => {
      renderGuidance(tipFrom(modelRefusal()));
      expect(screen.getByText(refusedCopy.modelSelectionRequired.title)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: actionCopy.chooseModel })).toBeInTheDocument();
    });

    it('shows the provider cause guidance', () => {
      renderGuidance(tipFrom(providerFailure()));
      expect(screen.getByText(turnFailedCopy.causes.providerAuth.title)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: actionCopy.openModelSettings })).toBeInTheDocument();
    });
  }
);

const guidanceCopy = (locale: typeof enConversation) => {
  const codes = locale.agentError.codes;
  const causes = codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes;
  return [
    locale.agentError.actions.chooseModel,
    locale.agentError.actions.openModelSettings,
    ...Object.values<string>(codes.USER_AGENT_OPERATION_REFUSED.modelSelectionRequired),
    ...['providerAuth', 'providerRateLimit', 'providerUnavailable', 'providerBadRequest', 'providerNetwork'].flatMap(
      (cause) => [causes[cause]?.title, causes[cause]?.body]
    ),
  ];
};

describe('builtin Aelix guidance locale copy', () => {
  const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');
  const english = guidanceCopy(enConversation);

  it.each(supportedLocaleNames.filter((localeName) => localeName !== 'en-US'))(
    'translates every guidance string in %s',
    (localeName) => {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));
      const copy = guidanceCopy(locale);
      expect(copy).toHaveLength(english.length);
      expect(copy.filter((text, index) => typeof text !== 'string' || !text.trim() || text === english[index])).toEqual(
        []
      );
    }
  );
});
