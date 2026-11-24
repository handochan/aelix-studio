/** Observe actual browser upload bytes and acknowledgments after the real Host responds. */
export function observeRenderer() {
  localStorage.setItem('i18nextLng', 'en-US');
  const fixture = (window.__runningImageFixture = {
    uploads: [],
    uploadRefs: [],
    mixedGrants: [],
    sawPreparing: false,
    uploadStatuses: [],
    acknowledgments: [],
    holdImageAck: false,
  });
  const preparing = '[data-testid="running-image-submission"][data-status="preparing"]';
  new MutationObserver((records) => {
    fixture.sawPreparing ||= records.some(
      ({ type, target, oldValue, addedNodes }) =>
        (type === 'attributes' &&
          target.matches('[data-testid="running-image-submission"]') &&
          (target.matches(preparing) || oldValue === 'preparing')) ||
        [...addedNodes].some(
          (node) => node instanceof Element && (node.matches(preparing) || node.querySelector(preparing))
        )
    );
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['data-status'],
  });
  const digest = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!globalThis.crypto?.subtle) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      return window.__fixtureHash(data.slice(data.indexOf(',') + 1));
    }
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
        if (this.status >= 200 && this.status < 300 && this.responseURL.endsWith('/api/fs/upload')) {
          const { data: ref } = JSON.parse(this.responseText);
          fixture.uploadRefs.push(ref);
          fixture.uploads.push(await image);
        }
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
    if (options?.method === 'POST' && path.endsWith('/fs/content/metadata')) kind = 'metadata';
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
    let mixedGrant;
    if (kind === 'grant' && fixture.expectedGrantPath) {
      mixedGrant = { requestedPngOnly: false, images: null };
      fixture.mixedGrants.push(mixedGrant);
      try {
        const { refs } = JSON.parse(options.body);
        mixedGrant.requestedPngOnly =
          refs.length === 1 && refs[0].kind === 'upload' && refs[0].path === fixture.expectedGrantPath;
      } catch {
        // Count malformed requests as issued and let the real fetch proceed.
      }
    }
    const response = await fetch(...args);
    if (kind) {
      const body = await response
        .clone()
        .json()
        .catch(() => undefined);
      if (mixedGrant && response.ok && body?.success === true && Array.isArray(body.data?.grants)) {
        mixedGrant.images = body.data.grants.map((grant) => ({ bytes: grant?.byteLength, sha256: grant?.sha256 }));
      }
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

export async function clickTimed(page, button, expectedGrantPath) {
  await button.evaluate((element, grantPath) => {
    const fixture = window.__runningImageFixture;
    fixture.clickTime = null;
    element.addEventListener(
      'click',
      () => {
        fixture.clickTime = performance.now();
        fixture.expectedGrantPath = grantPath;
      },
      { capture: true, once: true }
    );
  }, expectedGrantPath);
  await button.click();
  const start = await page.evaluate(() => window.__runningImageFixture.clickTime);
  if (!Number.isFinite(start)) throw new Error('Click timestamp missing');
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
