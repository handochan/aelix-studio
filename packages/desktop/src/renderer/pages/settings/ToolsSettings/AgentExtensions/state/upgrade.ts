/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionEntry, ProxyCredentials, StudioExtensionsRequest } from '@aionui/web-host';

// TODO(#121): replace these local shapes with the shared types once PR C is merged, and delete this file.
/*
 * "Update to latest" follows the contract of PR C (#121, `codex/studio-32-extension-upgrade`,
 * types.ts at b037fa75) until it is merged: then these local shapes give way to the shared
 * ones. Nothing here runs an upgrade unless the host lists `upgrade` on an entry, which only a
 * host with #121 does.
 */

/** Whether an entry can be upgraded online: from its source, the platform and the generation. */
export type UpgradeAvailability = 'available' | 'pinned' | 'confirmation_required';

export type UpgradeCommand = {
  action: 'upgrade';
  name: string;
  /** Confirms a legacy index origin whose version constraint was not kept. */
  allowUnpin?: boolean;
  proxyCredentials?: ProxyCredentials;
};

/** The upgrade availability the host listed for an entry; undefined before #121. */
export const upgradeOf = (entry: ExtensionEntry): UpgradeAvailability | undefined =>
  (entry as ExtensionEntry & { upgrade?: UpgradeAvailability }).upgrade;

/** An upgrade request through the shared channel, which takes the #121 shape once merged. */
export const upgradeRequest = (command: UpgradeCommand): StudioExtensionsRequest =>
  command as unknown as StudioExtensionsRequest;
