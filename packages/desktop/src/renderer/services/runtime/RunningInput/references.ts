import { conversation, fs, sessionMention, type SessionRef } from '@/common/adapter/ipcBridge';
import { AIONUI_FILES_MARKER, AIONUI_SESSIONS_END_MARKER, AIONUI_SESSIONS_MARKER } from '@/common/config/constants';
import type { ChatFileRef } from '@/common/types/chatFile';

export type RunningInputReferences = {
  files: readonly ChatFileRef[];
  sessions: readonly SessionRef[];
};

// Keep the agent-facing wire text in step with the host's session_mentions.rs.
const SESSION_HINT =
  'To deliver to the conversations below, use the session-message skill (address by conversation id); if it is unavailable, run `"$AIONUI_HELPER_BIN" session capabilities` for the delivery contract.';
const LINE_CONTROLS = /[\p{Cc}\u2028\u2029]/u;
const ABSOLUTE_PATH = /^(?:\/|\\\\|[a-z]:[\\/])/i;

function workspaceFromExtra(extra: unknown): string | undefined {
  const workspace =
    extra && typeof extra === 'object' && 'workspace' in extra && typeof extra.workspace === 'string'
      ? extra.workspace.trim()
      : '';
  if (LINE_CONTROLS.test(workspace)) throw new Error('Unrepresentable workspace');
  return workspace || undefined;
}

async function resolveSessionRow(conversationId: string, senderWorkspace: string | undefined, ref: SessionRef) {
  if (!ref.id || ref.id === conversationId || LINE_CONTROLS.test(ref.id))
    throw new Error('Invalid conversation reference');
  const response = await sessionMention.list.invoke({
    current_conversation_id: conversationId,
    id: ref.id,
    privateRead: true,
  });
  const target = response.items.find((item) => item.id === ref.id);
  if (!target || typeof target.name !== 'string') throw new Error('Conversation reference unavailable');

  const detail = await conversation.get.invoke({ id: target.id, privateRead: true });
  if (detail?.id !== target.id || (detail.extra && 'teamId' in detail.extra && detail.extra.teamId)) {
    throw new Error('Conversation reference unavailable');
  }
  const workspace = workspaceFromExtra(detail.extra);
  const workspaceField =
    workspace && workspace === senderWorkspace ? 'same' : `${workspace ?? 'unknown'} (differs from yours)`;
  const title = target.name.replace(/[\p{Cc}\u2028\u2029]/gu, ' ');
  return `${title}\t${target.id}\tworkspace: ${workspaceField}`;
}

async function resolveFile(ref: ChatFileRef) {
  const metadata = await fs.getContentMetadata.invoke({ file: ref, privateRead: true });
  if (typeof metadata?.path !== 'string' || !ABSOLUTE_PATH.test(metadata.path) || LINE_CONTROLS.test(metadata.path)) {
    throw new Error('File reference unavailable');
  }
  return metadata;
}

/** Resolve every reference through the host and append its ordinary-send text blocks in wire order. */
export async function prepareRunningInputMessage(
  conversationId: string,
  message: string,
  { files, sessions }: RunningInputReferences
): Promise<{ text: string; hasImage: boolean }> {
  const [resolvedFiles, sessionRows] = await Promise.all([
    Promise.all(files.map(resolveFile)),
    sessions.length === 0
      ? []
      : conversation.get.invoke({ id: conversationId, privateRead: true }).then((sender) => {
          if (sender?.id !== conversationId) throw new Error('Sender conversation unavailable');
          const workspace = workspaceFromExtra(sender.extra);
          return Promise.all(sessions.map((ref) => resolveSessionRow(conversationId, workspace, ref)));
        }),
  ]);
  let text = message;
  if (sessionRows.length > 0) {
    text += '\n\n' + [AIONUI_SESSIONS_MARKER, SESSION_HINT, ...sessionRows, AIONUI_SESSIONS_END_MARKER].join('\n');
  }
  if (resolvedFiles.length > 0) {
    text += '\n\n' + [AIONUI_FILES_MARKER, ...resolvedFiles.map(({ path }) => path)].join('\n');
  }
  return { text, hasImage: resolvedFiles.some(({ type }) => type?.startsWith('image/')) };
}
