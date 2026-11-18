/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync as _mkdirSync, existsSync, readdirSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { getPlatformServices } from '@/common/platform';
import { application } from '@/common/adapter/ipcBridge';
import type { TMessage } from '@/common/chat/chatLib';
import type {
  IChatConversationRefer,
  IEnvStorageRefer,
  ILegacyConfigStorageRefer,
  TChatConversation,
  TProviderWithModel,
} from '@/common/config/storage';
import { ConfigStorage, EnvStorage } from '@/common/config/storage';
import {
  copyDirectoryRecursively,
  ensureDirectory,
  getConfigPath,
  getDataPath,
  getTempPath,
  hasElectronAppPath,
  verifyDirectoryFiles,
} from './utils';
import { runLegacyDatabaseMigrations } from '@process/services/database/runLegacyDatabaseMigrations';
import { createJsonFileStore as JsonFileBuilder } from '../storage/jsonFile';
import { createConfigRecovery } from '../storage/configRecovery';
import { BUILTIN_IMAGE_GEN_ID } from '../resources/builtinMcp/constants';
// Platform and architecture types (moved from deleted updateConfig)
type PlatformType = 'win32' | 'darwin' | 'linux';
type ArchitectureType = 'x64' | 'arm64' | 'ia32' | 'arm';

const STORAGE_PATH = {
  config: 'aionui-config.txt',
  chatMessage: 'aionui-chat-message.txt',
  chat: 'aionui-chat.txt',
  env: '.aionui-env',
  assistants: 'assistants',
  skills: 'skills',
  cronSkills: 'cron-skills',
};

/** Legacy builtin-skills cache directory, cleaned up at startup after the
 * backend took ownership of the corpus. */
const LEGACY_BUILTIN_SKILLS_DIR = 'builtin-skills';

const getHomePage = getConfigPath;

const mkdirSync = (path: string) => {
  return _mkdirSync(path, { recursive: true });
};

/**
 * 迁移老版本数据从temp目录到userData/config目录
 */
const migrateLegacyData = async () => {
  const oldDir = getTempPath(); // 老的temp目录
  const newDir = getConfigPath(); // 新的userData/config目录

  try {
    // 检查新目录是否为空（不存在或者存在但无内容）
    const isNewDirEmpty =
      !existsSync(newDir) ||
      (() => {
        try {
          return existsSync(newDir) && readdirSync(newDir).length === 0;
        } catch (error) {
          console.warn('[AionUi] Warning: Could not read new directory during migration check:', error);
          return false; // 假设非空以避免迁移覆盖
        }
      })();

    // 检查迁移条件：老目录存在且新目录为空
    if (existsSync(oldDir) && isNewDirEmpty) {
      // 创建目标目录
      mkdirSync(newDir);

      // 复制所有文件和文件夹
      await copyDirectoryRecursively(oldDir, newDir);

      // 验证迁移是否成功
      const isVerified = await verifyDirectoryFiles(oldDir, newDir);
      if (isVerified) {
        // 确保不会删除相同的目录
        if (path.resolve(oldDir) !== path.resolve(newDir)) {
          try {
            await fs.rm(oldDir, { recursive: true });
          } catch (cleanupError) {
            console.warn('[AionUi] 原目录清理失败，请手动删除:', oldDir, cleanupError);
          }
        }
      }

      return true;
    }
  } catch (error) {
    console.error('[AionUi] 数据迁移失败:', error);
  }

  return false;
};

// Stable profile location: resetting env can lose a custom cacheDir as well.
export const ConfigRecovery = createConfigRecovery(path.join(getHomePage(), STORAGE_PATH.config));
const envFile = JsonFileBuilder<IEnvStorageRefer>(path.join(getHomePage(), STORAGE_PATH.env), {
  onReset: (preserved) => ConfigRecovery.mark(preserved),
});

const dirConfig = envFile.getSync('aionui.dir');

const cacheDir = dirConfig?.cacheDir || getHomePage();

const configPath = path.join(cacheDir, STORAGE_PATH.config);
const configFile = JsonFileBuilder<ILegacyConfigStorageRefer>(configPath, {
  empty: () => (ConfigRecovery.active() ? { 'update.autoCheck': false } : {}) as ILegacyConfigStorageRefer,
  onReset: (preserved) => ConfigRecovery.mark(preserved),
});

/** Recovery stays offline until the user explicitly saves the update preference. */
export async function readAutoCheckPreference(): Promise<boolean> {
  return ConfigRecovery.autoCheck(await configFile.get('update.autoCheck'));
}
type ConversationHistoryData = Record<string, TMessage[]>;

const _chatMessageFile = JsonFileBuilder<ConversationHistoryData>(path.join(cacheDir, STORAGE_PATH.chatMessage));
const _chatFile = JsonFileBuilder<IChatConversationRefer>(path.join(cacheDir, STORAGE_PATH.chat));

const chatFile = _chatFile;

const buildMessageListStorage = (conversation_id: string, dir: string) => {
  const fullName = path.join(dir, 'aionui-chat-history', conversation_id + '.txt');
  if (!existsSync(fullName)) {
    mkdirSync(path.join(dir, 'aionui-chat-history'));
  }
  return JsonFileBuilder<TMessage[]>(path.join(dir, 'aionui-chat-history', conversation_id + '.txt'), {
    empty: () => [],
  });
};

const conversationHistoryProxy = (options: typeof _chatMessageFile, dir: string) => {
  return {
    ...options,
    async set(key: string, data: TMessage[]) {
      const conversation_id = key;
      const storage = buildMessageListStorage(conversation_id, dir);
      return await storage.setJson(data);
    },
    async get(key: string): Promise<TMessage[]> {
      const conversation_id = key;
      const storage = buildMessageListStorage(conversation_id, dir);
      const data = await storage.toJson();
      if (Array.isArray(data)) return data;
      return [];
    },
    backup(conversation_id: string) {
      const storage = buildMessageListStorage(conversation_id, dir);
      return storage.backup(
        path.join(dir, 'aionui-chat-history', 'backup', conversation_id + '_' + Date.now() + '.txt')
      );
    },
  };
};

const chatMessageFile = conversationHistoryProxy(_chatMessageFile, cacheDir);

/**
 * 获取助手规则目录路径
 * Get assistant rules directory path
 */
const getAssistantsDir = () => {
  return path.join(cacheDir, STORAGE_PATH.assistants);
};

/**
 * 获取技能脚本目录路径
 * Get skills scripts directory path
 */
const getSkillsDir = () => {
  return path.join(cacheDir, STORAGE_PATH.skills);
};

/**
 * Get the directory for per-cron-job SKILL.md files.
 * Each cron job gets its own subdirectory: {cronSkillsDir}/{job_id}/SKILL.md
 */
const getCronSkillsDir = () => {
  return path.join(cacheDir, STORAGE_PATH.cronSkills);
};

/**
 * Best-effort cleanup of the legacy `{cacheDir}/builtin-skills/` directory
 * left behind by versions prior to the backend taking ownership of the skill
 * corpus. Failures are swallowed — at worst a stale copy lingers on disk.
 */
const cleanupLegacyBuiltinSkillsDir = () => {
  const legacyDir = path.join(cacheDir, LEGACY_BUILTIN_SKILLS_DIR);
  if (!existsSync(legacyDir)) return;
  fs.rm(legacyDir, { recursive: true, force: true })
    .then(() => console.log('[AionUi] Cleaned up legacy builtin-skills cache'))
    .catch(() => {
      /* swallow — cleanup is not critical */
    });
};

/**
 * Ensure user-facing config directories exist. Built-in assistant rules and
 * skill files are now owned by the backend (see
 * `crates/aionui-app/assets/builtin-assistants/` and
 * `crates/aionui-app/assets/builtin-skills/`) — neither is synced from
 * renderer resources anymore.
 */
const ensureAssistantDirs = async (): Promise<void> => {
  const assistantsDir = getAssistantsDir();
  const userSkillsDir = getSkillsDir();

  if (!existsSync(userSkillsDir)) mkdirSync(userSkillsDir);

  const cronSkillsDir = getCronSkillsDir();
  if (!existsSync(cronSkillsDir)) mkdirSync(cronSkillsDir);

  if (!existsSync(assistantsDir)) mkdirSync(assistantsDir);
};

const getBuiltinMcpBaseDir = (): string => {
  const mainModuleDir =
    typeof require !== 'undefined' && require.main?.filename ? path.dirname(require.main.filename) : __dirname;
  const baseDir = path.basename(mainModuleDir) === 'chunks' ? path.dirname(mainModuleDir) : mainModuleDir;
  // In packaged mode the main bundle lives inside app.asar, but external node
  // processes cannot read files from ASAR archives. Redirect to the unpacked copy.
  if (getPlatformServices().paths.isPackaged()) {
    return baseDir.replace('app.asar', 'app.asar.unpacked');
  }
  return baseDir;
};

/**
 * Resolve the path to a built-in MCP server entry script.
 * In development the file lives next to the main process bundle (out/main/);
 * in production it's inside the packaged app.
 */
const getBuiltinMcpScriptPath = (scriptName: string): string => {
  // initStorage may itself be code-split into out/main/chunks/.
  // Built-in MCP entry files are emitted next to the main entry in out/main/.
  return path.resolve(getBuiltinMcpBaseDir(), `${scriptName}.js`);
};

const initStorage = async () => {
  const t0 = performance.now();
  const mark = (label: string) => console.log(`[AionUi:init] ${label} +${Math.round(performance.now() - t0)}ms`);
  mark('start');

  // 1. 先执行数据迁移（在任何目录创建之前）
  await migrateLegacyData();
  mark('1. migrateLegacyData');

  // 2. 创建必要的目录（迁移后再创建，确保迁移能正常进行）
  // Use ensureDirectory to handle cases where a regular file blocks the path (#841)
  ensureDirectory(getHomePage());
  ensureDirectory(getDataPath());

  // 3. 初始化存储系统
  ConfigStorage.interceptor(configFile);
  EnvStorage.interceptor(envFile);
  mark('3. storage interceptors');

  mark('4. MCP config initialization skipped');

  // 5. Ensure assistant-related directories exist. Built-in assistant records
  //    now live in the backend SQLite catalog (see aionui-assistant crate) and
  //    are no longer seeded into ConfigStorage. User-authored rule md files
  //    continue to live under `{cacheDir}/assistants/` until the one-shot
  //    migration (T3b) imports them into the backend.
  try {
    await ensureAssistantDirs();
    mark('5. ensureAssistantDirs');
  } catch (error) {
    console.error('[AionUi] Failed to ensure assistant dirs:', error);
  }

  // 5b. Best-effort cleanup of the legacy builtin-skills cache left behind
  //     before the backend took ownership of the corpus.
  cleanupLegacyBuiltinSkillsDir();
  mark('5b. legacyBuiltinSkillsCleanup');

  // 6. Backend only understands the v26-era schema baseline. Older desktop
  //    users may still have a pre-v26 Electron-managed catalog, so we upgrade
  //    that file here, close it, and only then allow the backend to start.
  const legacyDbMigration = await runLegacyDatabaseMigrations();
  const repaired = legacyDbMigration.handoffRepair.repairedColumns.length;
  if (legacyDbMigration.skipped) {
    mark('6. legacyDbMigrations skipped');
  } else if (legacyDbMigration.migrated) {
    mark(
      `6. legacyDbMigrations v${legacyDbMigration.fromVersion}->v${legacyDbMigration.toVersion} handoffRepair=${repaired}`
    );
  } else {
    mark(`6. legacyDbMigrations noop(v${legacyDbMigration.fromVersion}) handoffRepair=${repaired}`);
  }

  if (hasElectronAppPath()) {
    application.systemInfo.provider(() => {
      return Promise.resolve(getSystemDir());
    });
  }
  mark('done');
};

export const ProcessConfig = configFile;

export const ProcessChat = chatFile;

export const ProcessChatMessage = chatMessageFile;

export const ProcessEnv = envFile;

export const getSystemDir = () => {
  // electron-log writes to the platform-standard logs directory
  const logDir = dirConfig?.logDir || getPlatformServices().paths.getLogsDir();

  return {
    cacheDir: cacheDir,
    // getDataPath() returns CLI-safe path (symlink on macOS) to avoid spaces
    // getDataPath() 返回 CLI 安全路径（macOS 上的符号链接）以避免空格问题
    workDir: dirConfig?.workDir || getDataPath(),
    logDir,
    platform: process.platform as PlatformType,
    arch: process.arch as ArchitectureType,
  };
};

/**
 * 获取助手规则目录路径（供其他模块使用）
 * Get assistant rules directory path (for use by other modules)
 */
export { getAssistantsDir, getSkillsDir, getCronSkillsDir, BUILTIN_IMAGE_GEN_ID, getBuiltinMcpScriptPath };

export default initStorage;
