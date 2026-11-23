/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getStudioExtensionService } from '@aionui/web-host';
import { startStandaloneExtensions, stopStandaloneExtensions } from '../../../packages/web-cli/src/studioExtensions.js';

describe('the extension helper of the packaged standalone WebUI', () => {
  let scratch = '';
  afterEach(async () => {
    await stopStandaloneExtensions();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('is configured memory-only for its route, and stopped with the WebUI', async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'studio-web-cli-extensions-'));
    const service = startStandaloneExtensions(scratch);
    expect(getStudioExtensionService()).toBe(service);
    const reply = await service.request('web:operator', { action: 'get_settings' });
    expect(reply).toMatchObject({ ok: true, data: { credentialMode: 'memory-only', hasSavedCredentials: false } });
    await stopStandaloneExtensions();
    expect(getStudioExtensionService()).toBeUndefined();
  });
});
