/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentErrorOwnership, AgentStreamErrorInfo } from '@/common/chat/chatLib';
import type { TFunction } from 'i18next';

/**
 * Builtin Aelix errors that carry enough validated data for specific guidance.
 *
 * The host forwards these shapes only after exact validation (aelix-studio-host
 * #77 and #82), and Studio parses them just as strictly: any other shape keeps
 * the generic error card. The copy never includes peer text.
 */
type ProviderCause =
  | 'provider_auth'
  | 'provider_rate_limit'
  | 'provider_unavailable'
  | 'provider_bad_request'
  | 'provider_network';

export type AelixErrorGuidance =
  | { kind: 'model_selection_required'; availableModels: number }
  | { kind: 'provider_failure'; cause: ProviderCause };

/** The next step offered on the card. Neither action resends the prompt. */
export type AelixErrorAction = 'choose_model' | 'open_model_settings';

export type AelixErrorCopy = {
  title: string;
  body: string;
  /** Who the user should look at: the provider for provider causes. */
  ownership: AgentErrorOwnership;
  action?: AelixErrorAction;
};

const MAX_AVAILABLE_MODELS = 0xffff_ffff;

// `unknown` is a valid cause too, but it keeps today's generic text.
const PROVIDER_CAUSES = new Set<string>([
  'provider_auth',
  'provider_rate_limit',
  'provider_unavailable',
  'provider_bad_request',
  'provider_network',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const parseModelSelectionRequired = (data: unknown): AelixErrorGuidance | undefined => {
  if (!isRecord(data) || !hasExactKeys(data, ['kind', 'configId', 'availableModels', 'retryable'])) return undefined;
  const { kind, configId, availableModels, retryable } = data;
  if (kind !== 'model_selection_required' || configId !== 'model' || retryable !== false) return undefined;
  if (
    typeof availableModels !== 'number' ||
    !Number.isInteger(availableModels) ||
    availableModels < 0 ||
    availableModels > MAX_AVAILABLE_MODELS
  ) {
    return undefined;
  }
  return { kind: 'model_selection_required', availableModels };
};

const parseProviderFailure = (data: unknown): AelixErrorGuidance | undefined => {
  if (!isRecord(data) || !hasExactKeys(data, ['kind', 'retryable', 'cause'])) return undefined;
  if (data.kind !== 'turn_failed_after_dispatch' || data.retryable !== false) return undefined;
  const cause = data.cause;
  if (!isRecord(cause) || !hasExactKeys(cause, ['kind', 'retryable']) || cause.retryable !== false) return undefined;
  if (typeof cause.kind !== 'string' || !PROVIDER_CAUSES.has(cause.kind)) return undefined;
  return { kind: 'provider_failure', cause: cause.kind as ProviderCause };
};

/** Returns guidance only for the exact builtin Aelix shapes; anything else is undefined. */
export const parseAelixErrorGuidance = (error: AgentStreamErrorInfo | undefined): AelixErrorGuidance | undefined => {
  if (!error) return undefined;
  if (error.code === 'USER_AGENT_OPERATION_REFUSED' && error.protocol_code === -32004) {
    return parseModelSelectionRequired(error.data);
  }
  if (error.code === 'USER_AGENT_TURN_FAILED_AFTER_DISPATCH' && error.protocol_code === -33002) {
    return parseProviderFailure(error.data);
  }
  return undefined;
};

const providerCopy = (cause: ProviderCause, t: TFunction): AelixErrorCopy => {
  const ownership: AgentErrorOwnership = 'user_llm_provider';
  switch (cause) {
    case 'provider_auth':
      return {
        title: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerAuth.title'),
        body: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerAuth.body'),
        ownership,
        action: 'open_model_settings',
      };
    case 'provider_rate_limit':
      return {
        title: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerRateLimit.title'),
        body: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerRateLimit.body'),
        ownership,
      };
    case 'provider_unavailable':
      return {
        title: t(
          'conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerUnavailable.title'
        ),
        body: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerUnavailable.body'),
        ownership,
      };
    case 'provider_bad_request':
      return {
        title: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerBadRequest.title'),
        body: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerBadRequest.body'),
        ownership,
        action: 'open_model_settings',
      };
    case 'provider_network':
      return {
        title: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerNetwork.title'),
        body: t('conversation.agentError.codes.USER_AGENT_TURN_FAILED_AFTER_DISPATCH.causes.providerNetwork.body'),
        ownership,
      };
  }
};

/** Localized title, body and next action for a builtin Aelix error, or undefined for the generic card. */
export const resolveAelixErrorCopy = (
  error: AgentStreamErrorInfo | undefined,
  t: TFunction
): AelixErrorCopy | undefined => {
  const guidance = parseAelixErrorGuidance(error);
  if (!guidance) return undefined;
  if (guidance.kind === 'provider_failure') return providerCopy(guidance.cause, t);
  // With no models to choose from, the picker cannot help: a model must be added in Settings.
  if (guidance.availableModels === 0) {
    return {
      title: t('conversation.agentError.codes.USER_AGENT_OPERATION_REFUSED.modelSelectionRequired.noModelsTitle'),
      body: t('conversation.agentError.codes.USER_AGENT_OPERATION_REFUSED.modelSelectionRequired.noModelsBody'),
      ownership: 'user_agent',
      action: 'open_model_settings',
    };
  }
  return {
    title: t('conversation.agentError.codes.USER_AGENT_OPERATION_REFUSED.modelSelectionRequired.title'),
    body: t('conversation.agentError.codes.USER_AGENT_OPERATION_REFUSED.modelSelectionRequired.body'),
    ownership: 'user_agent',
    action: 'choose_model',
  };
};
