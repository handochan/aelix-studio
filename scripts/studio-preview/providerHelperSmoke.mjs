import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NativeAuthService } from '../../packages/web-host/src/studio-auth/service.ts';
import { NATIVE_AUTH_HELPER } from '../../packages/web-host/src/studio-auth/helperSource.ts';
import { resolveNativeRuntime } from '../../packages/web-host/src/studio-auth/runtime.ts';

const runtime = process.env.AELIX_STUDIO_RUNTIME;
const sandbox = process.env.PROVIDER_SANDBOX;
assert.ok(runtime && sandbox && process.env.PROVIDER_OUTPUT);
const root = path.join(sandbox, 'helper-tests');
const env = { ...process.env, AELIX_CODING_AGENT_DIR: root };
const service = new NativeAuthService({ runtime, env });
const resolvedRuntime = resolveNativeRuntime(runtime);
assert.ok(resolvedRuntime, 'Selected native runtime unavailable');
const checks = [];
const record = (name) => checks.push(name);
async function catalog() {
  const reply = await service.request('probe', { action: 'catalog' });
  assert.ok(reply.ok && 'providers' in reply.data, 'Native catalog failed');
  return reply.data;
}
async function mutate(command) {
  return service.request('probe', { ...command, exclusive: true, revision: (await catalog()).revision });
}

const prefix = `
from aelix_ai.oauth._registry import register_oauth_provider
from aelix_ai.oauth.types import OAuthAuthInfo, OAuthPrompt, OAuthCredentials
class FixtureOAuth:
    id, name, uses_callback_server = 'synthetic-oauth', 'Synthetic OAuth', False
    async def login(self, callbacks):
        await callbacks.on_auth(OAuthAuthInfo(url='https://fixture.invalid/authorize?state=synthetic-state', instructions='Synthetic device code'))
        if os.environ.get('STUDIO_TEST_OAUTH_POLL') == '1':
            await asyncio.Event().wait()
        await callbacks.on_prompt(OAuthPrompt(message='Synthetic code', allow_empty=True))
        return OAuthCredentials(refresh='synthetic-refresh', access='synthetic-access', expires=9999999999999)
register_oauth_provider(FixtureOAuth())
`;
function oauth(revision, polling = false) {
  const child = spawn(resolvedRuntime.python, [...resolvedRuntime.helperArgs, '-c', prefix + NATIVE_AUTH_HELPER], {
    env: { ...env, ...(polling ? { STUDIO_TEST_OAUTH_POLL: '1' } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const frames = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (waiters.length) waiters.shift()(frame);
      else frames.push(frame);
    }
  });
  child.stdin.write(JSON.stringify({ action: 'login', provider: 'synthetic-oauth', exclusive: true, revision }) + '\n');
  const exit = new Promise((resolve) => child.once('close', resolve));
  const next = () =>
    Promise.race([
      frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve) => waiters.push(resolve)),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Bounded callback wait elapsed')), 5000);
        timer.unref();
      }),
    ]);
  return { child, next, exit };
}

try {
  const first = await catalog();
  assert.equal(fs.realpathSync(first.root), fs.realpathSync(root));
  assert.equal(
    first.providers.some((item) => item.configured),
    false
  );
  record('no_llm_bootstrap_and_explicit_cli_root');
  assert.ok((await mutate({ action: 'setKey', provider: 'openai', key: 'synthetic-a' })).ok);
  const previous = await catalog();
  assert.ok((await mutate({ action: 'setKey', provider: 'anthropic', key: 'synthetic-b' })).ok);
  assert.deepEqual(
    await service.request('probe', {
      action: 'setKey',
      provider: 'openai',
      key: 'synthetic-c',
      exclusive: true,
      revision: previous.revision,
    }),
    { ok: false, code: 'CONFLICT' }
  );
  record('external_revision_conflict_without_retry');
  assert.deepEqual(await mutate({ action: 'setKey', provider: 'openai', key: '!echo should-never-execute' }), {
    ok: false,
    code: 'INVALID_INPUT',
  });
  record('literal_key_rejects_shell_indirection');
  assert.deepEqual(
    await mutate({
      action: 'endpoint',
      provider: 'custom',
      model: 'one',
      endpoint: 'https://user:secret@example.invalid/v1',
      api: 'openai-completions',
    }),
    { ok: false, code: 'INVALID_ENDPOINT' }
  );
  assert.ok(
    (
      await mutate({
        action: 'endpoint',
        provider: 'custom',
        model: 'one',
        endpoint: 'http://127.0.0.1:9999/v1',
        api: 'openai-completions',
      })
    ).ok
  );
  record('custom_endpoint_native_schema_and_credential_url_rejection');
  assert.ok((await mutate({ action: 'logout', provider: 'openai' })).ok);
  const afterLogout = await catalog();
  assert.equal(afterLogout.providers.find((item) => item.id === 'anthropic').source, 'stored');
  assert.ok(!JSON.stringify(afterLogout).includes('synthetic-b'));
  assert.equal(fs.existsSync(process.env.AELIX_AUTH_PATH), false);
  if (process.platform === 'win32') {
    const privateAcl = execFileSync(
      resolvedRuntime.python,
      [
        ...resolvedRuntime.helperArgs,
        '-c',
        String.raw`
import os
from pathlib import Path
import win32api,win32con,win32security
token=win32security.OpenProcessToken(win32api.GetCurrentProcess(),win32con.TOKEN_QUERY)
try: sid=win32security.GetTokenInformation(token,win32security.TokenUser)[0]
finally: token.Close()
trusted={win32security.ConvertSidToStringSid(sid),'S-1-5-18','S-1-5-32-544','S-1-3-0','S-1-3-4'}
acl=win32security.GetNamedSecurityInfo(str(Path(os.environ['AELIX_CODING_AGENT_DIR'])/'auth.json'),win32security.SE_FILE_OBJECT,win32security.DACL_SECURITY_INFORMATION).GetSecurityDescriptorDacl()
assert acl is not None
for index in range(acl.GetAceCount()):
    ace=acl.GetAce(index)
    if ace[0][0] in (0,5) and ace[1] & 0x90000001:
        assert win32security.ConvertSidToStringSid(ace[-1]) in trusted
print('PRIVATE_ACL_VERIFIED')
`,
      ],
      { env, encoding: 'utf8' }
    );
    assert.equal(privateAcl.trim(), 'PRIVATE_ACL_VERIFIED');
    const temporary = path.join(root, 'auth.json.tmp');
    fs.writeFileSync(temporary, 'preexisting-untrusted-temporary');
    execFileSync(
      resolvedRuntime.python,
      [
        ...resolvedRuntime.helperArgs,
        '-c',
        String.raw`
import os
from pathlib import Path
import win32security
file=Path(os.environ['AELIX_CODING_AGENT_DIR'])/'auth.json.tmp'
acl=win32security.GetNamedSecurityInfo(str(file),win32security.SE_FILE_OBJECT,win32security.DACL_SECURITY_INFORMATION).GetSecurityDescriptorDacl()
acl.AddAccessAllowedAceEx(win32security.ACL_REVISION_DS,0,0x80000000,win32security.ConvertStringSidToSid('S-1-1-0'))
win32security.SetNamedSecurityInfo(str(file),win32security.SE_FILE_OBJECT,win32security.DACL_SECURITY_INFORMATION,None,None,acl,None)
`,
      ],
      { env }
    );
    const original = fs.readFileSync(path.join(root, 'auth.json'));
    assert.deepEqual(await mutate({ action: 'setKey', provider: 'openai', key: 'synthetic-private' }), {
      ok: false,
      code: 'PRIVATE_DIRECTORY_REQUIRED',
    });
    assert.deepEqual(fs.readFileSync(path.join(root, 'auth.json')), original);
    assert.equal(fs.readFileSync(temporary, 'utf8'), 'preexisting-untrusted-temporary');
    fs.unlinkSync(temporary);
    record('windows_shared_native_temporary_refused_without_credential_write');
  } else assert.equal(fs.statSync(path.join(root, 'auth.json')).mode & 0o777, 0o600);
  record('sequential_preservation_native_permissions_and_no_secret_projection');

  const success = oauth((await catalog()).revision);
  const auth = await success.next();
  assert.equal(auth.event, 'authorization');
  assert.equal(auth.instructions, 'Synthetic device code');
  const prompt = await success.next();
  assert.equal(prompt.allowEmpty, true);
  success.child.stdin.write(JSON.stringify({ challengeId: prompt.challengeId, value: '' }) + '\n');
  const done = await success.next();
  assert.ok(done.result?.providers.find((item) => item.id === 'synthetic-oauth')?.configured);
  assert.ok(!JSON.stringify(done).includes('synthetic-access'));
  await success.exit;
  record('synthetic_native_oauth_callbacks_and_success');

  assert.ok((await mutate({ action: 'logout', provider: 'synthetic-oauth' })).ok);

  // EOF settles native callbacks without saving a replacement token.
  const eof = oauth((await catalog()).revision);
  await eof.next();
  await eof.next();
  eof.child.stdin.end();
  assert.equal((await eof.next()).error, 'CANCELLED');
  await eof.exit;
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'auth.json')))['synthetic-oauth'], undefined);
  record('synthetic_native_oauth_eof_cancel');

  const polling = oauth((await catalog()).revision, true);
  assert.equal((await polling.next()).event, 'authorization');
  polling.child.stdin.end();
  assert.equal((await polling.next()).error, 'CANCELLED');
  await polling.exit;
  record('oauth_eof_cancels_remote_wait_without_an_input_prompt');

  const conflict = oauth((await catalog()).revision);
  await conflict.next();
  const challenge = await conflict.next();
  const existing = JSON.parse(fs.readFileSync(path.join(root, 'auth.json')));
  existing.external = { type: 'api_key', key: 'synthetic-external' };
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify(existing));
  conflict.child.stdin.write(JSON.stringify({ challengeId: challenge.challengeId, value: 'synthetic-code' }) + '\n');
  assert.equal((await conflict.next()).error, 'CONFLICT');
  await conflict.exit;
  record('oauth_external_edit_before_commit_refused');
  const saved = fs.readFileSync(path.join(root, 'auth.json'));
  fs.writeFileSync(path.join(root, 'auth.json'), '{corrupt');
  assert.deepEqual(await service.request('probe', { action: 'catalog' }), { ok: false, code: 'INVALID_CONFIG' });
  assert.equal(fs.readFileSync(path.join(root, 'auth.json'), 'utf8'), '{corrupt');
  fs.writeFileSync(path.join(root, 'auth.json'), saved);
  record('malformed_cli_credentials_refused_without_reset');
  fs.writeFileSync(
    path.join(process.env.PROVIDER_OUTPUT, 'helper.json'),
    JSON.stringify({ status: 'passed', checks, nativePatches: [], realOAuth: false }, null, 2) + '\n'
  );
  console.log(`Native Provider helper: ${checks.length} checks passed (synthetic OAuth)`);
} finally {
  service.dispose();
}
