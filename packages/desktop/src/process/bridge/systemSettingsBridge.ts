/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 系统设置桥接模块
 * System Settings Bridge Module
 *
 * 负责���理系统级设置的读写操作（如关闭到托盘）
 * Handles read/write operations for system-level settings (e.g. close to tray)
 */

import { ipcBridge } from '@/common';
import { getStudioExtensionService } from '@aionui/web-host';
import { app, session, webContents } from 'electron';
import { setStudioRendererOffline, STUDIO_UPDATER_PARTITION } from '@process/startup/backgroundNetworking';
import {
  ConfigRecovery,
  ProcessConfig,
  readAutoCheckPreference,
  readOfflineMode,
  saveOfflineMode,
} from '@process/utils/initStorage';
import { changeLanguage } from '@process/services/i18n';
import type { PetSize } from '@process/pet/petTypes';
import { createOrUpdateTray, destroyTray, refreshTrayMenu, setCloseToTrayEnabled } from '@process/utils/tray';
import { readCloseToTraySetting, writeCloseToTraySetting } from '@process/utils/closeToTraySetting';

type LanguageChangeListener = () => void;
let _languageChangeListener: LanguageChangeListener | null = null;
let offlineModeChange = Promise.resolve();

/**
 * 注册语言变更监听器（供主进程 index.ts 使用）
 * Register a listener for language changes (used by main process index.ts)
 */
export function onLanguageChanged(listener: LanguageChangeListener): void {
  _languageChangeListener = listener;
}

export function initSystemSettingsBridge(): void {
  ipcBridge.systemSettings.getOfflineMode.provider(async () => readOfflineMode());
  ipcBridge.systemSettings.setOfflineMode.provider(async ({ enabled }) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected boolean offline mode setting');
    const change = offlineModeChange.then(async () => {
      const previous = readOfflineMode();
      const renderer = session.defaultSession;
      if (enabled) await setStudioRendererOffline(app, renderer, true);
      try {
        if (enabled !== previous) await saveOfflineMode(enabled);
        if (!enabled) await setStudioRendererOffline(app, renderer, false);
      } catch (error) {
        if (readOfflineMode() !== previous) await saveOfflineMode(previous).catch(console.error);
        if (enabled && !previous) await setStudioRendererOffline(app, renderer, false).catch(console.error);
        throw error;
      }
      for (const guest of webContents.getAllWebContents()) {
        if (guest.getType() === 'webview' && guest.session === renderer) {
          guest.setWebRTCIPHandlingPolicy(enabled ? 'disable_non_proxied_udp' : 'default');
        }
      }
      try {
        if (enabled) {
          await Promise.all([
            session
              .fromPartition(STUDIO_UPDATER_PARTITION, { cache: false })
              .closeAllConnections()
              .catch(console.error),
            getStudioExtensionService()?.cancelOnlineOperations(),
          ]);
        }
      } finally {
        ipcBridge.systemSettings.offlineModeChanged.emit(readOfflineMode());
        void refreshTrayMenu().catch(console.error);
      }
    });
    offlineModeChange = change.catch(() => {});
    return change;
  });
  ipcBridge.systemSettings.getAutoUpdateEnabled.provider(readAutoCheckPreference);
  ipcBridge.systemSettings.setAutoUpdateEnabled.provider(async ({ enabled }) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected boolean update setting');
    await ProcessConfig.set('update.autoCheck', enabled);
    await ConfigRecovery.finish();
  });
  ipcBridge.systemSettings.getCloseToTray.provider(async () => readCloseToTraySetting());

  ipcBridge.systemSettings.setCloseToTray.provider(async ({ enabled }) => {
    await writeCloseToTraySetting(enabled);
    setCloseToTrayEnabled(enabled);
    if (enabled) {
      createOrUpdateTray();
    } else {
      destroyTray();
    }
  });

  // 语言变更通知，同步主进程 i18n 并通知托盘重建
  // Language change notification, sync main process i18n and notify tray rebuild
  ipcBridge.systemSettings.changeLanguage.provider(async ({ language }) => {
    // Broadcast to all renderers FIRST (desktop + WebUI) for real-time sync.
    // This must happen before the potentially slow main-process i18n switch.
    ipcBridge.systemSettings.languageChanged.emit({ language });
    _languageChangeListener?.();

    // Update main process i18n (non-blocking – don't let a hang here block the provider)
    changeLanguage(language).catch((error) => {
      console.error('[SystemSettings] Main process changeLanguage failed:', error);
    });
  });

  // Desktop pet settings
  ipcBridge.systemSettings.getPetEnabled.provider(async () => {
    const value = await ProcessConfig.get('pet.enabled');
    return value ?? false;
  });

  ipcBridge.systemSettings.setPetEnabled.provider(async ({ enabled }) => {
    const { createPetWindow, destroyPetWindow, isPetSupported } = await import('@process/pet/petManager');
    if (enabled && !isPetSupported()) {
      console.warn('[SystemSettings] Desktop pet is not supported in headless mode');
      return;
    }
    await ProcessConfig.set('pet.enabled', enabled);
    if (enabled) {
      createPetWindow();
    } else {
      destroyPetWindow();
    }
  });

  ipcBridge.systemSettings.getPetSize.provider(async () => {
    const value = await ProcessConfig.get('pet.size');
    return value ?? 280;
  });

  ipcBridge.systemSettings.setPetSize.provider(async ({ size }) => {
    await ProcessConfig.set('pet.size', size);
    const { resizePetWindow } = await import('@process/pet/petManager');
    resizePetWindow(size as PetSize);
  });

  ipcBridge.systemSettings.getPetDnd.provider(async () => {
    const value = await ProcessConfig.get('pet.dnd');
    return value ?? false;
  });

  ipcBridge.systemSettings.setPetDnd.provider(async ({ dnd }) => {
    await ProcessConfig.set('pet.dnd', dnd);
    const { setPetDndMode } = await import('@process/pet/petManager');
    setPetDndMode(dnd);
  });

  // Pet confirm-bubble toggle: when disabled, AI tool-call confirmations
  // are not routed to the pet's bubble window. Default true.
  ipcBridge.systemSettings.getPetConfirmEnabled.provider(async () => {
    const value = await ProcessConfig.get('pet.confirmEnabled');
    return value ?? true;
  });

  ipcBridge.systemSettings.setPetConfirmEnabled.provider(async ({ enabled }) => {
    await ProcessConfig.set('pet.confirmEnabled', enabled);
    const { setPetConfirmEnabled } = await import('@process/pet/petManager');
    setPetConfirmEnabled(enabled);
  });
}
