/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assistantRuntimeKey,
  canStartAssistantConversation,
  isAionrsAssistant,
  isBuiltinAelixAssistant,
  type Assistant,
} from '@/common/types/agent/assistantTypes';
import { configService } from '@/common/config/configService';
import type { AcpModelInfo } from '../types';
import type { AgentModeOption } from '@/renderer/utils/model/agentTypes';
import {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeSlashCommands,
  buildAgentRuntimeThoughtLevelOption,
  type AgentRuntimeCatalog,
  type AgentRuntimeDerivedOption,
} from '@/renderer/utils/model/agentRuntimeCatalog';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import { useManagedAgentRuntimeCatalog } from '@/renderer/hooks/agent/useManagedAgents';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { aelixModelId, loadNativeAuthCatalog, NATIVE_AUTH_CATALOG_KEY } from '@/renderer/services/runtime/nativeAuth';
import { recheckAelixAfterSessionFailure } from '@/renderer/services/runtime/aelixAvailability';
import { useCustomAgentsLoader } from './useCustomAgentsLoader';

export {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeSlashCommands,
  type AgentRuntimeCatalog,
};

export type GuidAssistantSelectionResult = {
  selectedAssistantId: string | null;
  setSelectedAssistantId: (assistantId: string) => void;
  defaultAssistantId: string | null;
  selectedAssistant: Assistant | undefined;
  selectedAssistantBackend: string;
  selectedAssistantAvailable: boolean;
  assistants: Assistant[];
  selectedMode: string;
  setSelectedMode: (mode: React.SetStateAction<string>, options?: { persistPreference?: boolean }) => void;
  selectedAcpModel: string | null;
  setSelectedAcpModel: (
    model: React.SetStateAction<string | null>,
    options?: { persistPreference?: boolean; explicit?: boolean }
  ) => void;
  currentAcpCachedModelInfo: AcpModelInfo | null;
  currentAgentAvailableCommands: SlashCommandItem[];
  currentAgentModeOptions: AgentModeOption[];
  currentThoughtLevelOption: AgentRuntimeDerivedOption | null;
  selectedThoughtLevelValue: string;
  setSelectedThoughtLevelValue: (
    value: React.SetStateAction<string>,
    options?: { persistPreference?: boolean }
  ) => void;
};

export function resolveInitialAssistantModel(models: string[]): string | null {
  if (models.length > 0) {
    return models[0];
  }

  return null;
}

export function buildAssistantModelInfo(models: string[]): AcpModelInfo | null {
  if (models.length > 0) {
    return {
      current_model_id: models[0],
      current_model_label: models[0],
      available_models: models.map((model) => ({ id: model, label: model })),
    } satisfies AcpModelInfo;
  }

  return null;
}

export function resolveAssistantSelectionKey(
  savedKey: string | undefined,
  assistants: Assistant[]
): string | undefined {
  if (!savedKey) return undefined;
  const id = savedKey.startsWith('custom:') ? savedKey.slice(7) : savedKey;
  return assistants.find((assistant) => assistant.id === id && canStartAssistantConversation(assistant))?.id;
}

function readPersistedGuidAssistantSelectionKey(assistants: Assistant[]): string | undefined {
  const savedKey = configService.get('guid.lastAssistantId');
  return resolveAssistantSelectionKey(savedKey, assistants);
}

function persistGuidAssistantSelectionKey(assistantId: string): void {
  void configService.set('guid.lastAssistantId', assistantId).catch((error) => {
    console.error('[Guid] Failed to persist selected assistant:', error);
  });
}

export function pickDefaultAssistantSelectionKey(assistants: Assistant[]): string | null {
  const enabledAssistants = assistants.filter(canStartAssistantConversation);
  const preferred =
    enabledAssistants.find(isBuiltinAelixAssistant) ??
    enabledAssistants.find((assistant) => assistant.source === 'generated' && isAionrsAssistant(assistant)) ??
    enabledAssistants.find((assistant) => isAionrsAssistant(assistant)) ??
    enabledAssistants[0];
  return preferred?.id ?? null;
}

/** Whether this page would choose `candidate` (preselected, saved, or default) if it were available. */
function wouldSelect(candidate: Assistant, assistants: Assistant[], preselectAssistantId?: string): boolean {
  const available = assistants.map((assistant) =>
    assistant.id === candidate.id ? { ...assistant, agent_status: 'online' as const } : assistant
  );
  const preferred =
    resolveAssistantSelectionKey(preselectAssistantId, available) ??
    readPersistedGuidAssistantSelectionKey(available) ??
    pickDefaultAssistantSelectionKey(available);
  return preferred === candidate.id;
}

type UseGuidAssistantSelectionOptions = {
  resetAssistant?: boolean;
  preselectAssistantId?: string;
  locationKey?: string;
};

export const useGuidAssistantSelection = ({
  resetAssistant,
  preselectAssistantId,
  locationKey,
}: UseGuidAssistantSelectionOptions): GuidAssistantSelectionResult => {
  const [selectedAssistantIdState, _setSelectedAssistantId] = useState<string | null>(null);
  const [selectedMode, _setSelectedMode] = useState<string>('default');
  const [selectedAcpModel, _setSelectedAcpModel] = useState<string | null>(null);
  const [selectedThoughtLevelValue, _setSelectedThoughtLevelValue] = useState<string>('');
  const { assistants } = useCustomAgentsLoader();
  const managedAgentRuntimeCatalog = useManagedAgentRuntimeCatalog();
  const explicitModelAssistantRef = useRef<string | null>(null);
  const userPickedAssistantRef = useRef(false);

  const setSelectedMode = useCallback(
    (mode: React.SetStateAction<string>, _options?: { persistPreference?: boolean }) => {
      _setSelectedMode((prev) => {
        const nextMode = typeof mode === 'function' ? mode(prev) : mode;
        return nextMode;
      });
    },
    []
  );

  const setSelectedAcpModel = useCallback(
    (modelId: React.SetStateAction<string | null>, options?: { persistPreference?: boolean; explicit?: boolean }) => {
      if (options?.explicit) explicitModelAssistantRef.current = selectedAssistantIdState;
      _setSelectedAcpModel((prev) => {
        const nextModelId = typeof modelId === 'function' ? modelId(prev) : modelId;
        return nextModelId;
      });
    },
    [selectedAssistantIdState]
  );

  const setSelectedThoughtLevelValue = useCallback(
    (value: React.SetStateAction<string>, _options?: { persistPreference?: boolean }) => {
      _setSelectedThoughtLevelValue((prev) => {
        const nextValue = typeof value === 'function' ? value(prev) : value;
        return nextValue;
      });
    },
    []
  );

  const setSelectedAssistantId = useCallback(
    (assistantId: string) => {
      const normalizedId = resolveAssistantSelectionKey(assistantId, assistants);
      if (!normalizedId) return;
      userPickedAssistantRef.current = true;
      _setSelectedAssistantId(normalizedId);
      persistGuidAssistantSelectionKey(normalizedId);
    },
    [assistants]
  );

  const resetHandledRef = useRef(false);
  const prevLocationKeyRef = useRef(locationKey);
  if (locationKey !== prevLocationKeyRef.current) {
    prevLocationKeyRef.current = locationKey;
    resetHandledRef.current = false;
  }

  useLayoutEffect(() => {
    if (!resetHandledRef.current && assistants.length > 0) {
      const resolvedPreselect = resolveAssistantSelectionKey(preselectAssistantId, assistants);
      if (resolvedPreselect) {
        resetHandledRef.current = true;
        _setSelectedAssistantId(resolvedPreselect);
        return;
      }

      if (resetAssistant) {
        resetHandledRef.current = true;
        _setSelectedAssistantId(
          readPersistedGuidAssistantSelectionKey(assistants) ?? pickDefaultAssistantSelectionKey(assistants)
        );
        return;
      }
    }

    if (!resolveAssistantSelectionKey(selectedAssistantIdState ?? undefined, assistants)) {
      _setSelectedAssistantId(
        readPersistedGuidAssistantSelectionKey(assistants) ?? pickDefaultAssistantSelectionKey(assistants)
      );
    }
  }, [assistants, locationKey, preselectAssistantId, resetAssistant, selectedAssistantIdState]);

  // One failed session (even a transient network error) leaves Aelix offline until a probe.
  // Probe once per visit when Aelix would be the choice; the probe records a non-session
  // verdict, so a still-broken Aelix is not probed again.
  const aelixRecheckStartedRef = useRef(false);
  const [aelixProbed, setAelixProbed] = useState(false);
  useEffect(() => {
    if (aelixRecheckStartedRef.current) return;
    const aelix = assistants.find(isBuiltinAelixAssistant);
    if (!aelix || aelix.enabled === false || aelix.agent_status !== 'offline') return;
    if (!wouldSelect(aelix, assistants, preselectAssistantId)) return;
    aelixRecheckStartedRef.current = true;
    void recheckAelixAfterSessionFailure()
      .catch(() => false)
      .then((probed) => {
        if (probed) setAelixProbed(true);
      });
  }, [assistants, preselectAssistantId]);

  // Restore Aelix as the choice once the refreshed list shows it, unless the user picked another.
  useLayoutEffect(() => {
    if (!aelixProbed) return;
    const aelix = assistants.find(isBuiltinAelixAssistant);
    if (!aelix || !canStartAssistantConversation(aelix)) return;
    setAelixProbed(false);
    if (!userPickedAssistantRef.current) _setSelectedAssistantId(aelix.id);
  }, [aelixProbed, assistants]);

  const selectedAssistant = useMemo(
    () =>
      assistants.find(
        (assistant) => assistant.id === selectedAssistantIdState && canStartAssistantConversation(assistant)
      ),
    [assistants, selectedAssistantIdState]
  );
  const selectedAssistantId = selectedAssistant?.id ?? null;
  const selectedAssistantBackend = assistantRuntimeKey(selectedAssistant);
  const selectedAssistantModels = selectedAssistant?.models ?? [];
  const selectedManagedAgentRuntimeCatalog = useMemo(
    () =>
      selectedAssistant?.agent_id
        ? managedAgentRuntimeCatalog.find((agent) => agent.id === selectedAssistant.agent_id)
        : undefined,
    [managedAgentRuntimeCatalog, selectedAssistant?.agent_id]
  );
  const cachedAgentRuntimeModelInfo = useMemo(
    () => buildAgentRuntimeModelInfo(selectedManagedAgentRuntimeCatalog),
    [selectedManagedAgentRuntimeCatalog]
  );
  // The ACP catalog is a snapshot from the last session: a fresh profile has none, and it
  // misses providers configured since. The helper lists them; Send still confirms live.
  const { data: nativeCatalog } = useSWR(
    isBuiltinAelixAssistant(selectedAssistant) ? NATIVE_AUTH_CATALOG_KEY : null,
    loadNativeAuthCatalog
  );
  const selectedAgentRuntimeModelInfo = useMemo<AcpModelInfo | null>(() => {
    if (!nativeCatalog) return cachedAgentRuntimeModelInfo;
    const advertised = new Set(cachedAgentRuntimeModelInfo?.available_models.map((model) => model.id));
    const configured = nativeCatalog.providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.available)
        .map((model) => ({
          id: aelixModelId(provider.id, model.id),
          label: model.name,
          description: provider.name,
        }))
        .filter((model) => !advertised.has(model.id))
    );
    if (!cachedAgentRuntimeModelInfo) {
      return { current_model_id: null, current_model_label: null, available_models: configured };
    }
    if (configured.length === 0) return cachedAgentRuntimeModelInfo;
    return {
      ...cachedAgentRuntimeModelInfo,
      available_models: [...cachedAgentRuntimeModelInfo.available_models, ...configured],
    };
  }, [cachedAgentRuntimeModelInfo, nativeCatalog]);
  const currentAgentAvailableCommands = useMemo(
    () => buildAgentRuntimeSlashCommands(selectedManagedAgentRuntimeCatalog),
    [selectedManagedAgentRuntimeCatalog]
  );
  const selectedAgentRuntimeModeState = useMemo(
    () => buildAgentRuntimeModeState(selectedManagedAgentRuntimeCatalog),
    [selectedManagedAgentRuntimeCatalog]
  );
  const selectedAgentRuntimeThoughtLevelOption = useMemo(
    () => buildAgentRuntimeThoughtLevelOption(selectedManagedAgentRuntimeCatalog),
    [selectedManagedAgentRuntimeCatalog]
  );
  const currentThoughtLevelOption = useMemo<AgentRuntimeDerivedOption | null>(() => {
    if (!selectedAgentRuntimeThoughtLevelOption) return null;
    return {
      ...selectedAgentRuntimeThoughtLevelOption,
      currentValue: selectedThoughtLevelValue || selectedAgentRuntimeThoughtLevelOption.currentValue,
    };
  }, [selectedAgentRuntimeThoughtLevelOption, selectedThoughtLevelValue]);
  const currentAgentModeOptions = selectedAgentRuntimeModeState.options;

  const selectedAssistantAvailable = Boolean(selectedAssistant);

  const modelSelectionScopeRef = useRef<string | null>(null);
  useEffect(() => {
    // A CLI agent's runtime catalog must NOT seed a selection. `current_model_id` there is
    // whatever the LAST session of this agent wrote back — not this user's intent — and
    // `available_models[0]` is the agent's own "Default" row, which for claude is a REAL
    // choice (it pins the account default, overriding the user's ANTHROPIC_MODEL). Seeding
    // either one turned "I have not picked a model" into a silent pick, so a fresh
    // conversation could never start on the model `claude` itself would have used.
    //
    // `null` is the meaningful value: `useGuidSend` omits the model override entirely, and
    // the agent then resolves it from the user's own config, exactly as its CLI does. The
    // picker renders this as no checkmark + the generic "default model" label, and once a
    // session exists the backend reports the model it actually resolved to.
    //
    // Assistants backed by an API provider have no runtime catalog; they keep seeding from
    // their own `models` list, which is a real per-assistant configuration.
    const fallbackModelId = selectedAgentRuntimeModelInfo
      ? null
      : selectedAssistantModels.length > 0
        ? resolveInitialAssistantModel(selectedAssistantModels)
        : null;
    const availableModelIds = new Set(
      selectedAgentRuntimeModelInfo?.available_models.map((model) => model.id) ?? selectedAssistantModels
    );
    const selectionScope = selectedAssistantId ?? '';
    const scopeChanged = modelSelectionScopeRef.current !== selectionScope;
    modelSelectionScopeRef.current = selectionScope;
    if (scopeChanged) explicitModelAssistantRef.current = null;
    const retainExplicitModel =
      isBuiltinAelixAssistant(selectedAssistant) && explicitModelAssistantRef.current === selectedAssistantId;

    _setSelectedAcpModel((previousModelId) => {
      if (
        !scopeChanged &&
        previousModelId &&
        (retainExplicitModel || availableModelIds.size === 0 || availableModelIds.has(previousModelId))
      ) {
        return previousModelId;
      }

      return fallbackModelId;
    });
  }, [selectedAssistant, selectedAssistantId, selectedAssistantModels, selectedAgentRuntimeModelInfo]);

  useEffect(() => {
    const fallbackMode =
      selectedAgentRuntimeModeState.currentMode || selectedAgentRuntimeModeState.options[0]?.value || 'default';
    _setSelectedMode(fallbackMode);
  }, [selectedAgentRuntimeModeState]);

  const thoughtLevelSelectionScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const optionValues = new Set(selectedAgentRuntimeThoughtLevelOption?.options.map((option) => option.value) ?? []);
    const fallbackThoughtLevel =
      selectedAgentRuntimeThoughtLevelOption?.currentValue ||
      selectedAgentRuntimeThoughtLevelOption?.options[0]?.value ||
      '';
    const selectionScope = selectedAssistantId ?? '';

    _setSelectedThoughtLevelValue((previousValue) => {
      const scopeChanged = thoughtLevelSelectionScopeRef.current !== selectionScope;
      thoughtLevelSelectionScopeRef.current = selectionScope;

      if (!selectedAgentRuntimeThoughtLevelOption) {
        return '';
      }

      if (!scopeChanged && previousValue && optionValues.has(previousValue)) {
        return previousValue;
      }

      return fallbackThoughtLevel;
    });
  }, [selectedAgentRuntimeThoughtLevelOption, selectedAssistantId]);

  const currentAcpCachedModelInfo = useMemo(() => {
    if (selectedAgentRuntimeModelInfo) {
      return selectedAgentRuntimeModelInfo;
    }

    return buildAssistantModelInfo(selectedAssistantModels);
  }, [selectedAssistantModels, selectedAgentRuntimeModelInfo]);

  const defaultAssistantId = useMemo(() => pickDefaultAssistantSelectionKey(assistants), [assistants]);

  return {
    selectedAssistantId,
    setSelectedAssistantId,
    defaultAssistantId,
    selectedAssistant,
    selectedAssistantBackend,
    selectedAssistantAvailable,
    assistants,
    selectedMode,
    setSelectedMode,
    selectedAcpModel,
    setSelectedAcpModel,
    currentAcpCachedModelInfo,
    currentAgentAvailableCommands,
    currentAgentModeOptions,
    currentThoughtLevelOption,
    selectedThoughtLevelValue,
    setSelectedThoughtLevelValue,
  };
};
