/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentLogoMap } from '@/renderer/utils/model/agentLogo';
import {
  fetchAgentLogos,
  resolveAgentAvatar,
  resolveAgentLogo,
  isDefaultModel,
  getModelDisplayLabel,
  resolveRuntimeAssistantAvatar,
  resolveGeneratedAssistantLogo,
  AELIX_MARK_DATA_URL,
} from '@/renderer/utils/model/agentLogo';
import { resolveAssistantAvatar } from '@/renderer/utils/model/assistantAvatar';

const bridgeMocks = vi.hoisted(() => ({
  getManagedAgents: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      getManagedAgents: { invoke: bridgeMocks.getManagedAgents },
    },
  },
}));

vi.mock('@/renderer/utils/platform', () => ({
  resolveBackendAssetUrl: (url: string) => url,
}));

// Backend logo catalog returned by `useAgentLogos()` in production. The unit
// test passes it explicitly to the pure `resolveAgentLogo`.
const LOGOS: AgentLogoMap = {
  claude: '/api/assets/logos/ai-major/claude.svg',
  emojiagent: '🧠',
  gemini: '/api/assets/logos/ai-major/gemini.svg',
  opencode: '/api/assets/logos/tools/coding/opencode-light.svg',
  'openclaw-gateway': '/api/assets/logos/tools/openclaw.svg',
};

describe('agentLogo', () => {
  let originalDocument: Document | undefined;

  beforeEach(() => {
    bridgeMocks.getManagedAgents.mockReset();
    if (typeof document !== 'undefined') {
      originalDocument = document;
    }
    global.document = {
      documentElement: {
        getAttribute: vi.fn(() => 'light'),
      },
    } as any;
  });

  afterEach(() => {
    if (originalDocument) {
      global.document = originalDocument as any;
    }
  });

  describe('resolveAgentLogo (backend lookup)', () => {
    it('returns logo path for known backend (case-insensitive)', () => {
      expect(resolveAgentLogo(LOGOS, { backend: 'Claude' })).toContain('/api/assets/logos/ai-major/claude.svg');
    });

    it('returns logo for lowercase input', () => {
      expect(resolveAgentLogo(LOGOS, { backend: 'gemini' })).toContain('/api/assets/logos/ai-major/gemini.svg');
    });

    it('returns null for unknown backend', () => {
      expect(resolveAgentLogo(LOGOS, { backend: 'unknown-agent' })).toBeNull();
    });

    it('returns null for null/undefined/empty backend', () => {
      expect(resolveAgentLogo(LOGOS, { backend: null })).toBeNull();
      expect(resolveAgentLogo(LOGOS, { backend: undefined })).toBeNull();
      expect(resolveAgentLogo(LOGOS, { backend: '' })).toBeNull();
    });

    it('tolerates a missing catalog map', () => {
      expect(resolveAgentLogo(undefined as unknown as AgentLogoMap, { backend: 'claude' })).toBeNull();
    });

    it('uses the backend-provided opencode logo without applying a theme variant', () => {
      (global.document.documentElement.getAttribute as any).mockReturnValue('dark');
      expect(resolveAgentLogo(LOGOS, { backend: 'opencode' })).toContain('opencode-light.svg');
    });

    it('does not expose local absolute paths as logo sources', () => {
      expect(resolveAgentLogo(LOGOS, { icon: '/Users/demo/.aionui/agent-avatars/custom.png' })).toBeNull();
    });
  });

  describe('resolveAgentAvatar', () => {
    it('keeps explicit emoji avatars as emoji', () => {
      expect(resolveAgentAvatar(LOGOS, { icon: '🧠', backend: 'claude' })).toEqual({
        kind: 'emoji',
        value: '🧠',
      });
    });

    it('falls back to backend catalog logos when explicit local paths leak through', () => {
      expect(
        resolveAgentAvatar(LOGOS, { icon: '/Users/demo/.aionui/agent-avatars/custom.png', backend: 'claude' })
      ).toEqual({
        kind: 'image',
        value: '/api/assets/logos/ai-major/claude.svg',
      });
    });

    it('keeps backend catalog emoji avatars as emoji', () => {
      expect(resolveAgentAvatar(LOGOS, { backend: 'emojiagent' })).toEqual({
        kind: 'emoji',
        value: '🧠',
      });
    });
  });

  describe('fetchAgentLogos', () => {
    it('builds the logo catalog from /api/agents/management rows', async () => {
      bridgeMocks.getManagedAgents.mockResolvedValue([
        {
          id: 'agent-claude',
          name: 'Claude',
          agent_type: 'acp',
          agent_source: 'builtin',
          backend: 'claude',
          enabled: true,
          installed: true,
          status: 'online',
          icon: '/api/assets/logos/ai-major/claude.svg',
        },
      ]);

      await expect(fetchAgentLogos()).resolves.toEqual({
        'agent-claude': '/api/assets/logos/ai-major/claude.svg',
        claude: '/api/assets/logos/ai-major/claude.svg',
      });
      expect(bridgeMocks.getManagedAgents).toHaveBeenCalledTimes(1);
    });

    it("does not lend one custom ACP agent's icon to icon-less custom agents", async () => {
      const custom = { agent_type: 'acp', agent_source: 'custom', enabled: true, installed: true, status: 'online' };
      bridgeMocks.getManagedAgents.mockResolvedValue([
        { ...custom, id: 'native-aelix', name: 'Aelix', icon: AELIX_MARK_DATA_URL },
        { ...custom, id: 'my-agent', name: 'My agent' },
      ]);

      const logos = await fetchAgentLogos();

      expect(logos).toEqual({ 'native-aelix': AELIX_MARK_DATA_URL });
      // Agent settings and cron jobs look an agent up by backend, else by its agent type.
      expect(resolveAgentAvatar(logos, { backend: 'acp' })).toEqual({ kind: 'fallback' });
      expect(resolveAgentLogo(logos, { backend: 'acp' })).toBeNull();
      expect(resolveAgentLogo(logos, { backend: 'native-aelix' })).toBe(AELIX_MARK_DATA_URL);
    });

    it('keeps single-runtime agent types as logo keys', async () => {
      bridgeMocks.getManagedAgents.mockResolvedValue([
        {
          id: 'gateway',
          name: 'OpenClaw',
          agent_type: 'openclaw-gateway',
          agent_source: 'builtin',
          enabled: true,
          installed: true,
          status: 'online',
          icon: '/api/assets/logos/tools/openclaw.svg',
        },
      ]);

      // OpenClaw conversations without a backend fall back to the agent type.
      await expect(fetchAgentLogos()).resolves.toMatchObject({
        'openclaw-gateway': '/api/assets/logos/tools/openclaw.svg',
      });
    });
  });

  describe('resolveAgentLogo (priority)', () => {
    it('prioritizes explicit icon', () => {
      expect(resolveAgentLogo(LOGOS, { icon: '/api/custom/icon.svg', backend: 'claude' })).toContain(
        '/api/custom/icon.svg'
      );
    });

    it('falls back to backend ID', () => {
      expect(resolveAgentLogo(LOGOS, { backend: 'gemini' })).toContain('gemini.svg');
    });

    it('extracts adapter ID from custom_agent_id for extensions', () => {
      expect(resolveAgentLogo(LOGOS, { isExtension: true, custom_agent_id: 'ext:my-ext:claude' })).toContain(
        'claude.svg'
      );
    });

    it('returns null when no match found', () => {
      expect(resolveAgentLogo(LOGOS, { backend: 'unknown' })).toBeNull();
    });
  });

  describe('isDefaultModel', () => {
    it('returns true when value contains default', () => {
      expect(isDefaultModel('gpt-4-default', null)).toBe(true);
    });

    it('returns true when label contains recommended', () => {
      expect(isDefaultModel(null, 'recommended model')).toBe(true);
    });

    it('returns true when text contains 默认', () => {
      expect(isDefaultModel('', '默认模型')).toBe(true);
    });

    it('returns false when no keywords present', () => {
      expect(isDefaultModel('gpt-4', 'GPT-4')).toBe(false);
    });

    it('handles null inputs', () => {
      expect(isDefaultModel(null, null)).toBe(false);
    });
  });

  describe('getModelDisplayLabel', () => {
    it('returns selectedLabel when provided and not default', () => {
      const result = getModelDisplayLabel({
        selected_value: 'gpt-4',
        selectedLabel: 'GPT-4 Turbo',
        defaultModelLabel: 'Default',
        fallbackLabel: 'Unknown',
      });
      expect(result).toBe('GPT-4 Turbo');
    });

    it('keeps a specific model label even when it includes the default tier suffix', () => {
      const result = getModelDisplayLabel({
        selected_value: 'gpt-4',
        selectedLabel: 'GPT-4 (default)',
        defaultModelLabel: 'Default Model',
        fallbackLabel: 'Unknown',
      });
      expect(result).toBe('GPT-4 (default)');
    });

    it('keeps a generic default option label unchanged', () => {
      const result = getModelDisplayLabel({
        selected_value: 'default/default',
        selectedLabel: 'Default (default)',
        defaultModelLabel: 'Default Model',
        fallbackLabel: 'Unknown',
      });
      expect(result).toBe('Default (default)');
    });

    it('falls back to fallbackLabel when selectedLabel is null', () => {
      const result = getModelDisplayLabel({
        selected_value: 'gpt-4',
        selectedLabel: null,
        defaultModelLabel: 'Default',
        fallbackLabel: 'Unnamed Model',
      });
      expect(result).toBe('Unnamed Model');
    });

    it('returns fallbackLabel when selectedLabel is empty', () => {
      const result = getModelDisplayLabel({
        selected_value: 'gpt-4',
        selectedLabel: '',
        defaultModelLabel: 'Default',
        fallbackLabel: 'Fallback',
      });
      expect(result).toBe('Fallback');
    });
  });
});

const isAelixMark = (value: string | null | undefined) =>
  /aria-label=['"]Aelix mark['"]/.test(decodeURIComponent(value ?? ''));

describe('Aelix agent logo', () => {
  it('uses the bundled Aelix mark for the aelix backend, ahead of the catalog', () => {
    const logos: AgentLogoMap = { ...LOGOS, aelix: '/api/assets/logos/tools/other.svg' };
    expect(isAelixMark(resolveAgentLogo(logos, { backend: 'Aelix' }))).toBe(true);
    expect(isAelixMark(resolveAgentLogo({}, { backend: 'aelix' }))).toBe(true);
  });

  it('keeps an explicit icon over the Aelix mark', () => {
    expect(resolveAgentLogo(LOGOS, { icon: '/api/assets/custom.svg', backend: 'aelix' })).toBe(
      '/api/assets/custom.svg'
    );
  });

  it('returns the Aelix mark as an image avatar unless the assistant has its own', () => {
    const avatar = resolveAgentAvatar(LOGOS, { backend: 'aelix' });
    expect(avatar.kind).toBe('image');
    expect(avatar.kind === 'image' && isAelixMark(avatar.value)).toBe(true);
    expect(resolveAgentAvatar(LOGOS, { icon: '🧬', backend: 'aelix' })).toEqual({ kind: 'emoji', value: '🧬' });
  });

  it('does not change other backends', () => {
    expect(isAelixMark(resolveAgentLogo(LOGOS, { backend: 'claude' }))).toBe(false);
  });

  it('fills only a missing avatar of an Aelix-runtime assistant', () => {
    const assistant = { avatar: undefined, source: 'user' as const, agent_id: 'claude' };
    const aelix = resolveRuntimeAssistantAvatar(LOGOS, { ...assistant, runtime: 'aelix' });
    expect(aelix.kind === 'image' && isAelixMark(aelix.value)).toBe(true);
    expect(resolveRuntimeAssistantAvatar(LOGOS, { ...assistant, avatar: '🧪', runtime: 'aelix' })).toEqual({
      kind: 'emoji',
      value: '🧪',
    });
    expect(resolveRuntimeAssistantAvatar(LOGOS, { ...assistant, runtime: 'claude' })).toEqual({ kind: 'fallback' });
  });

  it('stores the mark as an agent icon that renders as an image', () => {
    expect(resolveAgentLogo({}, { icon: AELIX_MARK_DATA_URL })).toBe(AELIX_MARK_DATA_URL);
    expect(resolveAgentAvatar({}, { icon: AELIX_MARK_DATA_URL })).toEqual({
      kind: 'image',
      value: AELIX_MARK_DATA_URL,
    });
    expect(resolveAssistantAvatar(AELIX_MARK_DATA_URL)).toEqual({ kind: 'image', value: AELIX_MARK_DATA_URL });
    expect(isAelixMark(AELIX_MARK_DATA_URL)).toBe(true);
  });

  it("gives a generated assistant without an avatar its agent's icon", () => {
    // The host keeps a native Aelix agent's data URL icon on the agent row only.
    const logos: AgentLogoMap = { ...LOGOS, '77905fd1': AELIX_MARK_DATA_URL };
    const generated = { avatar: '', source: 'generated' as const, agent_id: '77905fd1', runtime: 'acp' };
    expect(resolveGeneratedAssistantLogo(logos, { source: 'generated', agentId: '77905fd1' })).toBe(
      AELIX_MARK_DATA_URL
    );
    expect(resolveRuntimeAssistantAvatar(logos, generated)).toEqual({ kind: 'image', value: AELIX_MARK_DATA_URL });
    // A user's own assistant on the same agent keeps the regular fallback.
    expect(resolveGeneratedAssistantLogo(logos, { source: 'user', agentId: '77905fd1' })).toBeNull();
    expect(resolveRuntimeAssistantAvatar(logos, { ...generated, source: 'user' })).toEqual({ kind: 'fallback' });
  });
});
