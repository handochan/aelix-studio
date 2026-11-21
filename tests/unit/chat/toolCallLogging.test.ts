import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMessageIndex, composeMessageWithIndex } from '@/renderer/pages/conversation/Messages/hooks';
import type { TMessage } from '@/common/chat/chatLib';

describe('tool call diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns with safe metadata when dropping a tool_call without call_id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const marker = 'C:\\private-workspace\\tool "name"';
    const message = {
      type: 'tool_call',
      msg_id: 'msg-1',
      conversation_id: 'conversation-1',
      content: {
        call_id: '',
        name: marker,
        status: marker,
        args: { command: 'secret command' },
        input: { prompt: 'secret prompt' },
        output: 'secret output',
      },
    } as TMessage;

    const list: TMessage[] = [];
    expect(JSON.stringify(message)).toContain(JSON.stringify(marker).slice(1, -1));
    expect(composeMessageWithIndex(message, list, buildMessageIndex(list))).toBe(list);
    expect(warn).toHaveBeenCalledExactlyOnceWith('[tool-call] dropped tool_call without call_id');
  });
});
