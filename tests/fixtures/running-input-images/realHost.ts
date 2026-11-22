// Run with Bun and the local Host, ACP source and unchanged native runtime (see README).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { crc32, deflateSync } from 'node:zlib';
import { registerDesktopBackendFetcher } from '@/common/adapter/desktopBackendFetch';
import { createRunningInputClient, IMAGE_ONLY_CAPTION } from '@renderer/services/runtime/RunningInput';
import { INPUT_METHODS, createRequestId } from '@renderer/services/runtime/RunningInput/transport';
import { emptyNativeImageLine } from '@renderer/services/runtime/RunningInput/imageProtocol';
import { nativeLineBytes } from '@renderer/services/runtime/RunningInput/Images/budget';
import { probeDerivative } from './realHostBrowser';

const [hostBinary, acpSource, python, aelix] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(aelix, 'Usage: bun realHost.ts HOST ACP_SRC ACP_PYTHON AELIX');
// Keep the isolated ACP Unix socket path within Darwin's sockaddr_un limit.
const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'studio-image-core-'));
const workspace = join(root, 'workspace');
const hostData = join(root, 'host');
const agent = join(root, 'agent');
const home = join(root, 'home');
const tmp = join(root, 'tmp');
const isolatedEnv = {
  ...Object.fromEntries(
    ['PATH', 'SYSTEMROOT', 'WINDIR'].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))
  ),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_CACHE_HOME: join(home, 'cache'),
  TMPDIR: tmp,
  TMP: tmp,
  TEMP: tmp,
};
const wire = join(root, 'wire.jsonl');
const auth = randomBytes(32).toString('hex');
const calls: { key: string; kind: 'grant' | 'write' | 'lookup'; bindingId: string; digest?: string }[] = [];

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let heldResponse: ReturnType<typeof deferred> | undefined = deferred();
const providerImages: { digest: string; text: string }[] = [];
let providerRequests = 0;
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const { messages, model } = await request.json();
    providerRequests++;
    await heldResponse?.promise;
    for (const message of messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      for (const part of message.content.filter((part) => part.type === 'image_url')) {
        const bytes = Buffer.from(part.image_url.url.split(',')[1], 'base64');
        providerImages.push({ digest: createHash('sha256').update(bytes).digest('hex'), text });
      }
    }
    const frame = { id: 'fixture', object: 'chat.completion.chunk', model, created: 0 };
    return new Response(
      [
        {
          ...frame,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture reply' }, finish_reason: null }],
        },
        { ...frame, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]
        .map((part) => `data: ${JSON.stringify(part)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
      {
        headers: { 'content-type': 'text/event-stream' },
      }
    );
  },
});
const endpoint = `http://127.0.0.1:${provider.port}/v1`;
const hostPortProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
const port = hostPortProbe.port;
hostPortProbe.stop();
const base = `http://127.0.0.1:${port}`;
let processHost: ReturnType<typeof Bun.spawn> | undefined;
let client: ReturnType<typeof createRunningInputClient> | undefined;
let holdAck: ReturnType<typeof deferred> | undefined;

async function api(path: string, body?: object) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-aionui-studio-auth': auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json();
  assert.ok(response.ok && envelope.success, `Fixture API failed (${response.status})`);
  return envelope.data;
}

async function until<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const result = await read();
    if (result) return result;
    await Bun.sleep(40);
  }
  throw new Error('Fixture observation timed out');
}

async function start() {
  const output = await open(join(root, 'host.log'), 'a');
  try {
    processHost = Bun.spawn(
      [
        hostBinary,
        '--local',
        '--studio-auth',
        '--port',
        String(port),
        '--data-dir',
        hostData,
        '--managed-resources-mode',
        'bundled',
        '--log-level',
        'trace',
      ],
      {
        cwd: workspace,
        stdin: Buffer.from(auth),
        stdout: output.fd,
        stderr: output.fd,
        env: {
          ...isolatedEnv,
          AELIX_CODING_AGENT_DIR: agent,
          AELIX_SETTINGS_PATH: join(agent, 'settings.json'),
          AIONUI_DISABLE_AUTO_UPDATE: '1',
        },
      }
    );
  } finally {
    await output.close();
  }
  await until(async () => api('/api/assistants').catch(() => false));
}

function chunk(type: string, data: Uint8Array) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(type, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, checksum]);
}

function png(width: number, bytes?: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = chunk('IHDR', header);
  const idat = chunk('IDAT', deflateSync(Buffer.alloc(width + 1), { level: 0 }));
  const iend = chunk('IEND', Buffer.alloc(0));
  const padding = bytes
    ? [chunk('npAD', Buffer.alloc(bytes - signature.length - ihdr.length - idat.length - iend.length - 12))]
    : [];
  return Buffer.concat([signature, ihdr, idat, ...padding, iend]);
}

const writes = async (): Promise<{ bytes: number; caption: boolean; count: number }[]> =>
  (await readFile(wire, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

try {
  await Promise.all([workspace, hostData, agent, home, tmp].map((path) => mkdir(path)));
  await writeFile(wire, '');
  await writeFile(
    join(agent, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: endpoint,
          api: 'openai-completions',
          apiKey: 'fixture-only',
          models: [
            { id: 'vision', name: 'Fixture Vision', input: ['text', 'image'], contextWindow: 196608, maxTokens: 4096 },
          ],
        },
      },
    })
  );
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'fixture',
      defaultModel: 'vision',
      compaction: { enabled: false },
      retry: { enabled: false },
    })
  );

  const policy = {
    route: ['fixture', 'vision', 'openai-completions', endpoint],
    imageBytes: 3_750_000,
    sidePixels: 8000,
    rawBytes: 8 << 20,
    count: 20,
    bodyBytes: 12 << 20,
    contextTokens: 196608,
    imageTokens: 8192,
    outputTokens: 4096,
  };
  const launcher = join(root, 'launch.py');
  await writeFile(
    launcher,
    `
import json
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(acpSource)})
import aelix_acp.server as server
import aelix_acp.session as session

class FixtureServer(server.Server):
    def __init__(self, args):
        super().__init__(args)
        self.image_policies = (json.loads(${JSON.stringify(JSON.stringify(policy))}),)

original_rpc = session.Session.rpc
async def instrumented(self, command, **kwargs):
    image_write = kwargs.get("_image_write")
    if image_write is not None:
        current, issued = image_write
        def mark():
            issued()
            frame = {"id": "0" * 32, "type": command, "message": kwargs["message"], "images": kwargs["images"]}
            with Path(${JSON.stringify(wire)}).open("a", encoding="utf-8") as out:
                out.write(json.dumps({"bytes": len(session.encode_frame(frame)),
                                      "caption": kwargs["message"] == "The user attached one or more images.",
                                      "count": len(kwargs["images"])}) + "\\n")
        kwargs["_image_write"] = (current, mark)
    return await original_rpc(self, command, **kwargs)

session.Session.rpc = instrumented
server.Server = FixtureServer
server.main()
`
  );
  await start();
  processHost!.kill();
  await processHost!.exited;
  const db = new Database(join(hostData, 'aionui-backend.db'));
  try {
    db.run(
      `INSERT INTO agent_metadata
      (id,agent_id,user_id,name,backend,agent_type,agent_source,command,args,created_at,updated_at)
      VALUES ('fixture-aelix','fixture-aelix',NULL,'Fixture ACP','aelix','acp','builtin',?,?,1,1)`,
      [
        python,
        JSON.stringify([launcher, '--aelix', aelix, '--permission-mode', 'yolo', '--state-dir', join(root, 'acp')]),
      ]
    );
  } finally {
    db.close();
  }
  await start();
  const conversation = await api('/api/conversations', {
    type: 'acp',
    name: 'Running image fixture',
    extra: { agent_id: 'fixture-aelix', backend: 'aelix', workspace, custom_workspace: true },
  });
  const scope = '/api/conversations/' + conversation.id;
  await api(scope + '/runtime/ensure', {});
  let loseGrant = false;
  let loseAck = false;
  let beforeGrant: (() => Promise<void>) | undefined;
  let writing = deferred();
  registerDesktopBackendFetcher(async (url, init) => {
    const path = new URL(url).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const headers = new Headers(init?.headers);
    headers.set('x-aionui-studio-auth', auth);
    const response = await fetch(base + new URL(url).pathname + new URL(url).search, { ...init, headers });
    if (path.endsWith('/byte-grants')) {
      const descriptor = await response.clone().json();
      calls.push({
        kind: 'grant',
        bindingId: body.bindingId,
        key: body.prepareId,
        digest: descriptor.data?.grants[0]?.sha256,
      });
      await beforeGrant?.();
      if (loseGrant) {
        loseGrant = false;
        throw new Error('fixture grant response loss');
      }
    }
    if (body.method === INPUT_METHODS.steerImages || body.method === INPUT_METHODS.followUpImages) {
      calls.push({ kind: 'write', bindingId: body.bindingId, key: body.payload.requestId });
      writing.release();
      await holdAck?.promise;
      if (loseAck) {
        loseAck = false;
        throw new Error('fixture ACK loss');
      }
    }
    if (body.method === INPUT_METHODS.lookup) {
      calls.push({ kind: 'lookup', bindingId: body.bindingId, key: body.payload.requestId });
    }
    return response;
  });

  client = createRunningInputClient(conversation.id);
  await api(scope + '/messages', { content: 'hold the first provider request' });
  await until(() => providerRequests);
  const target = await until(async () => {
    await client!.refresh();
    const { channel } = client!.getSnapshot();
    return channel.status === 'ready' && channel.turn.active && channel.pixelModes?.includes('steer')
      ? { bindingId: channel.bindingId, turnId: channel.turn.turnId }
      : undefined;
  });
  const path = join(workspace, 'synthetic-private-png.png');
  const bytes = png(64);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, bytes);
  const ref = (file: string) => ({ ref: { kind: 'local' as const, path: file } });
  const submit = (
    message: string,
    sources = [ref(path)],
    controller = new AbortController(),
    mode: 'steer' | 'follow-up' = 'steer'
  ) =>
    client!.submitImages({
      ...target,
      mode,
      requestId: createRequestId(),
      message,
      sources,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    });

  loseGrant = true;
  const result = await submit('');
  assert.equal(result.status === 'sent' && result.receipt.status, 'queued');
  assert.ok(result.status === 'sent' && result.receipt.status === 'queued' && result.receipt.captionAdded);
  const batch = result.receipt.pixels!;
  assert.deepEqual(batch.images[0].original, { width: 64, height: 1, bytes: bytes.length });
  assert.deepEqual(batch.images[0].sent, { width: 64, height: 1, bytes: bytes.length, sha256: digest });
  assert.equal(client.getImagePreview(result.receipt.requestId, digest), undefined);
  assert.deepEqual(await writes(), [{ bytes: batch.estimatedLineBytes, caption: true, count: 1 }]);
  assert.deepEqual(
    calls.map(({ kind, key, bindingId }) => [kind, key, bindingId]),
    ['grant', 'grant', 'write'].map((kind) => [kind, result.receipt.requestId, target.bindingId])
  );
  assert.ok(calls.slice(0, 2).every((call) => call.digest === digest));

  const invalid = join(workspace, 'conversion-failure.png');
  await writeFile(invalid, png(8001).subarray(0, -5));
  const noWrite = await submit('do not submit the rest', [ref(path), ref(invalid)]);
  assert.equal(noWrite.status, 'blocked');
  assert.equal((await writes()).length, 1);
  assert.equal(calls.length, 3);

  const typedCaptionPath = join(workspace, 'typed-caption.png');
  const typedCaptionBytes = png(65);
  const typedDigest = createHash('sha256').update(typedCaptionBytes).digest('hex');
  await writeFile(typedCaptionPath, typedCaptionBytes);

  loseAck = true;
  const uncertain = await submit(IMAGE_ONLY_CAPTION, [ref(typedCaptionPath)]);
  assert.ok(uncertain.status === 'sent' && uncertain.receipt.status === 'unknown' && uncertain.preserveDraft);
  const lookup = await client.lookup(uncertain.receipt.requestId);
  assert.ok(
    lookup.status === 'completed' && lookup.receipt.status === 'queued' && lookup.receipt.captionAdded === false
  );
  assert.equal(calls.at(-1)?.key, uncertain.receipt.requestId);
  assert.equal((await writes()).length, 2);

  const derivativePath = join(workspace, 'studio-derivative-문.png');
  const derivativeSource = png(8001, 3_750_001);
  await writeFile(derivativePath, derivativeSource);
  const derivativeMessage = 'private-image-body-문-"\\\n';
  const derivative = await probeDerivative({
    id: conversation.id,
    source: derivativePath,
    message: derivativeMessage,
    host: base,
    auth,
    env: isolatedEnv,
  });
  assert.equal((await writes()).length, 3);

  heldResponse?.release();
  heldResponse = undefined;
  for (const [expectedDigest, expectedText] of [
    [digest, IMAGE_ONLY_CAPTION],
    [typedDigest, IMAGE_ONLY_CAPTION],
    [derivative.digest, derivativeMessage],
  ]) {
    await until(() => providerImages.some((entry) => entry.digest === expectedDigest && entry.text === expectedText));
  }
  await until(async () => !(await api(scope)).runtime?.is_processing);

  async function newTurn() {
    heldResponse = deferred();
    const previous = providerRequests;
    await api(scope + '/messages', { content: 'hold another provider request' });
    await until(() => providerRequests > previous);
    const next = await until(async () => {
      await client!.refresh();
      const channel = client!.getSnapshot().channel;
      return channel.status === 'ready' && channel.turn.active
        ? { bindingId: channel.bindingId, turnId: channel.turn.turnId }
        : undefined;
    });
    Object.assign(target, next);
    const runtime = (await api(scope)).runtime;
    assert.ok(runtime?.turn_id);
    return runtime.turn_id as string;
  }

  async function stop(turnId: string) {
    const result = await api(scope + '/cancel', { turn_id: turnId });
    heldResponse?.release();
    heldResponse = undefined;
    return result;
  }

  // End the active turn after a real grant and before the Studio image method.
  const stale = await newTurn();
  beforeGrant = async () => {
    await stop(stale);
    await until(async () => !(await api(scope)).runtime?.is_processing);
  };
  const preDispatch = await submit('keep this draft');
  beforeGrant = undefined;
  assert.equal(preDispatch.status, 'blocked');
  assert.equal(client.getSnapshot().imageSubmission?.status, 'blocked');
  assert.equal((await writes()).length, 3);

  const boundaryTurn = await newTurn();
  const nativeLineLimit = 8 << 20;
  const first = join(workspace, 'file-at-limit.png');
  const second = join(workspace, 'batch-at-line-limit.png');
  const sizes = [3_750_000, (6 << 20) - 3_750_000 - 2048];
  await writeFile(first, png(8000, sizes[0]));
  await writeFile(second, png(1, sizes[1]));
  const message = '한"\\\n';
  const pad =
    nativeLineLimit - nativeLineBytes(emptyNativeImageLine('steer', message, ['image/png', 'image/png']), sizes);
  for (const offset of [1, -1, 0]) {
    const previous = (await writes()).length;
    const outcome = await submit(message + 'x'.repeat(pad + offset), [ref(first), ref(second)]);
    const observed = await writes();
    if (offset === 1) {
      assert.equal(outcome.status, 'blocked');
      assert.equal(observed.length, previous);
    } else {
      assert.ok(
        outcome.status === 'sent' && outcome.receipt.status === 'queued' && outcome.receipt.captionAdded === false
      );
      assert.equal(observed.length, previous + 1);
      assert.equal(observed.at(-1)?.bytes, nativeLineLimit + offset);
    }
  }

  const boundary = join(workspace, 'file-boundary.png');
  for (const [width, byteLength, shouldQueue] of [
    [7999, 3_749_999, true],
    [8000, 3_750_000, true],
    [8000, 3_750_001, false],
    [8001, 3_750_000, false],
  ] as const) {
    const previous = (await writes()).length;
    await writeFile(boundary, png(width, byteLength));
    const boundaryResult = await submit('file boundary', [ref(boundary)]);
    assert.equal(boundaryResult.status, shouldQueue ? 'sent' : 'blocked');
    assert.equal((await writes()).length, previous + Number(shouldQueue));
  }
  const rawBaseline = (await writes()).length;
  for (const offset of [-1, 0, 1]) {
    // The base64 and envelope exceed 8 MiB at all three raw boundaries. This
    // fixture has no canvas, so the necessary conversion cannot complete.
    await writeFile(second, png(1, (6 << 20) - sizes[0] + offset));
    assert.equal((await submit('raw boundary', [ref(first), ref(second)])).status, 'blocked');
    assert.equal((await writes()).length, rawBaseline);
  }
  const smallFiles = await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const file = join(workspace, `count-${index}.png`);
      await writeFile(file, png(64 + index));
      return ref(file);
    })
  );
  for (const count of [3, 4, 5]) {
    const previous = (await writes()).length;
    const counted = await submit('count boundary', smallFiles.slice(0, count));
    assert.equal(counted.status, count <= 4 ? 'sent' : 'blocked');
    assert.equal((await writes()).length, previous + Number(count <= 4));
  }
  await stop(boundaryTurn);
  await until(async () => !(await api(scope)).runtime?.is_processing);

  // Stop before the composer observes ACP's acknowledged native follow-up.
  const beforeLate = (await writes()).length;
  const active = await newTurn();
  const controller = new AbortController();
  holdAck = deferred();
  writing = deferred();
  const pending = submit('late follow-up', [ref(path)], controller, 'follow-up');
  let waitingAtAck = false;
  void writing.promise.then(() => {
    waitingAtAck = true;
  });
  await Promise.race([
    until(() => waitingAtAck),
    pending.then(() => {
      throw new Error('Late ACK fixture did not dispatch');
    }),
  ]);
  controller.abort();
  await stop(active);
  await client.refresh();
  holdAck.release();
  const late = await pending;
  assert.ok(late.status === 'sent' && late.receipt.status === 'queued' && late.preserveDraft);
  assert.equal(late.receipt.turnId, target.turnId);
  assert.equal(late.receipt.bindingId, target.bindingId);
  assert.equal((await writes()).length, beforeLate + 1);

  const hostLog = await readFile(join(root, 'host.log'), 'utf8');
  const logDirectory = join(hostData, 'logs');
  const logEntries = await readdir(logDirectory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    logEntries.filter((file) => file.isFile()).map((file) => readFile(join(logDirectory, file.name), 'utf8'))
  );
  assert.ok(
    hostLog.includes('TRACE') && derivative.diagnostics.some((line) => line.includes('[ensureWs]')),
    'Diagnostic capture did not observe both Host trace and renderer console'
  );
  const diagnostics = [hostLog, ...files, ...derivative.diagnostics].join('\n');
  const markers = [
    path,
    basename(path),
    digest,
    bytes.toString('base64').slice(0, 76),
    derivativePath,
    basename(derivativePath),
    derivativeMessage,
    createHash('sha256').update(derivativeSource).digest('hex'),
    ...derivative.markers,
  ];
  for (const marker of markers) {
    const escaped = JSON.stringify(marker).slice(1, -1);
    const ascii = escaped.replace(/[^\x20-\x7e]/g, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    const doubleEscaped = [escaped, ascii].map((value) => JSON.stringify(value).slice(1, -1));
    for (const variant of new Set([marker, escaped, ascii, ...doubleEscaped])) {
      assert.ok(!diagnostics.includes(variant), 'Private image fixture data in Host or renderer diagnostics');
    }
  }
  console.log(
    'Real Host/ACP: PNG and Chromium derivative bytes, both caption origins, exact line boundary, original-key recovery, late ACK after Stop and clean diagnostics'
  );
} finally {
  heldResponse?.release();
  holdAck?.release();
  client?.dispose();
  provider.stop(true);
  if (processHost?.exitCode === null) {
    processHost.kill();
    await processHost.exited;
  }
  await rm(root, { recursive: true, force: true });
}
