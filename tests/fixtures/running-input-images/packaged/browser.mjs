/** Observe actual browser upload bytes and acknowledgments after the real Host responds. */
export function observeRenderer() {
  localStorage.setItem('i18nextLng', 'en-US');
  const fixture = (window.__runningImageFixture = {
    uploads: [],
    uploadStatuses: [],
    acknowledgments: [],
    holdImageAck: false,
  });
  const digest = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!globalThis.crypto?.subtle) return window.__fixtureHash(Array.from(bytes));
    return {
      bytes: bytes.length,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join(''),
    };
  };

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    const file = body instanceof FormData ? body.get('file') : undefined;
    if (file instanceof Blob) {
      const image = digest(file).catch(() => null);
      this.addEventListener('load', async () => {
        fixture.uploadStatuses.push(this.status);
        if (this.status >= 200 && this.status < 300) fixture.uploads.push(await image);
      });
    }
    return send.call(this, body);
  };

  const fetch = window.fetch;
  window.fetch = async (...args) => {
    const [url, options] = args;
    const path = new URL(url, location.href).pathname;
    let kind;
    if (options?.method === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(path)) {
      kind = 'prompt';
    }
    if (options?.method === 'POST' && path.endsWith('/cancel')) kind = 'abort';
    if (options?.method === 'POST' && path.endsWith('/byte-grants')) kind = 'grant';
    if (options?.method === 'POST' && path.endsWith('/acp-extensions')) {
      const envelope = JSON.parse(options.body);
      kind = {
        '_aelix/session/input/state': 'turn-state',
        '_aelix/session/input/image-state': 'image-state',
        '_aelix/session/input/steer-images': 'steer-images',
        '_aelix/session/input/follow-up-images': 'follow-up-images',
        '_aelix/session/input/steer': 'steer',
        '_aelix/session/input/follow-up': 'follow-up',
      }[envelope.method];
    }
    const response = await fetch(...args);
    if (kind) {
      const body = await response
        .clone()
        .json()
        .catch(() => undefined);
      fixture.acknowledgments.push({
        kind,
        status: response.status,
        success: response.ok && body?.success === true,
        captionAdded: body?.data?.result?.captionAdded === true,
        active: body?.data?.result?.active === true,
        queued: body?.data?.result?.accepted === true && body?.data?.result?.delivery === 'native-queue',
        time: performance.now(),
      });
      if (kind.endsWith('-images') && fixture.holdImageAck) {
        await new Promise((resolve) => {
          fixture.releaseImageAck = resolve;
        });
      }
    }
    return response;
  };
}

export async function attach(page, paths, expectedUploads, stage) {
  // A hidden file input is only a way to obtain real browser File objects
  // without serializing base64 through Playwright. The real drop handler uploads them.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.id = 'image-acceptance-files';
    document.body.append(input);
  });
  const input = page.locator('#image-acceptance-files');
  stage('attach-files');
  await input.setInputFiles(paths);
  stage('attach-drop');
  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    for (const file of element.files) transfer.items.add(file);
    element.remove();
    document
      .querySelector('.sendbox-panel')
      .dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  stage('attach-upload');
  await page.waitForFunction((count) => window.__runningImageFixture.uploads.length === count, expectedUploads);
}

export async function clickTimed(page, button) {
  const start = await page.evaluate(() => performance.now());
  await button.click();
  return start;
}

export async function takeAck(page, kind, start) {
  const observation = await page
    .waitForFunction(
      ({ kind, start }) =>
        window.__runningImageFixture.acknowledgments.find((row) => row.kind === kind && row.time >= start),
      { kind, start },
      { timeout: 25000 }
    )
    .then((handle) => handle.jsonValue());
  return {
    success: observation.success,
    captionAdded: observation.captionAdded,
    queued: observation.queued,
    ms: Math.round(observation.time - start),
  };
}
