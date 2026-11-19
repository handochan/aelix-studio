"""Released-host smoke keeps owned paths and isolated GUI environment boundaries."""
import importlib.util
import contextlib
import os
import json
import shutil
import sys
import subprocess
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace, ModuleType

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / 'scripts/studio-preview/host-release/smoke.py'

class HostReleaseSmokeTests(unittest.TestCase):
    def test_gui_keeps_display_transport_without_importing_provider_secrets_or_user_roots(self):
        spec = importlib.util.spec_from_file_location('host_recovery_smoke', PATH)
        smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(smoke)
        isolated = {'HOME': 'owned-home', 'PATH': 'owned-path'}
        driver = {'DISPLAY': ':91', 'XAUTHORITY': '/owned-xvfb/auth', 'API_KEY': 'synthetic-secret', 'HOME': 'operator-home'}
        self.assertEqual(smoke.gui_environment(isolated, driver),
                         dict(isolated, DISPLAY=':91', XAUTHORITY='/owned-xvfb/auth'))


class InstalledForkTests(unittest.TestCase):
    def setUp(self):
        source = ROOT / 'scripts/studio-preview/providerSmoke.py'
        with patch.object(sys, 'path', [str(source.parent), *sys.path]):
            spec = importlib.util.spec_from_file_location('installed_fork_smoke', source)
            self.smoke = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.smoke)

    def test_fork_requires_two_distinct_bindings_in_the_actual_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with contextlib.closing(sqlite3.connect(root / 'aionui-backend.db')) as db, db:
                db.execute('CREATE TABLE acp_session (conversation_id TEXT PRIMARY KEY, session_id TEXT)')
                db.executemany('INSERT INTO acp_session VALUES (?, ?)', [
                    ('parent', 'parent-session'), ('pending', None), ('aliased', 'parent-session'),
                    ('child', 'child-session'),
                ])
            for child in ('missing', 'pending', 'aliased'):
                with self.subTest(child=child), self.assertRaisesRegex(AssertionError, 'distinct stored ACP'):
                    self.smoke.verify_fork_bindings(root, 'parent', child)
            self.smoke.verify_fork_bindings(root, 'parent', 'child')

    def test_cold_restart_rejects_replacement_acp_or_native_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            host_db = root / 'aionui-backend.db'
            with contextlib.closing(sqlite3.connect(host_db)) as db, db:
                db.execute('CREATE TABLE acp_session (conversation_id TEXT PRIMARY KEY, session_id TEXT)')
                db.executemany('INSERT INTO acp_session VALUES (?, ?)', [('parent', 'parent-acp'), ('child', 'child-acp')])
            (root / 'acp').mkdir()
            parent = root / 'parent.jsonl'
            child = root / '한글' / 'child.jsonl'
            child.parent.mkdir()
            parent.write_text(json.dumps({'id': '63087769-155d-4dce-9d17-b0f06f3ffd25'}), encoding='utf-8')
            child_header = {'id': '703bf557-4078-42d5-81a5-22f8edf29459', 'parentSession': str(parent)}
            child.write_text(json.dumps(child_header), encoding='utf-8')
            with contextlib.closing(sqlite3.connect(root / 'acp/sessions.sqlite3')) as db, db:
                db.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, file TEXT)')
                db.executemany('INSERT INTO sessions VALUES (?, ?)', [
                    ('parent-acp', str(parent)), ('child-acp', str(child)), ('replacement-acp', str(child)),
                ])
            before = self.smoke.read_fork_identity(root, 'parent', 'child')
            self.smoke.verify_restarted_fork(root, 'parent', 'child', before)
            report = root / 'host.json'
            report.write_text(json.dumps({'status': 'pending_payload_audit', 'headFork': {
                'parentId': 'parent', 'childId': 'child', 'beforeRestart': before,
            }}, ensure_ascii=False), encoding='utf-8')
            read_text = Path.read_text
            with patch.object(Path, 'read_text', autospec=True,
                              side_effect=lambda p, encoding=None: read_text(p, encoding=encoding or 'cp1252')):
                self.assertEqual(self.smoke.read_provider_report(root, report), {'status': 'pending_payload_audit'})
            with self.subTest(changed='native child'):
                child.write_text(json.dumps(dict(child_header, id='51d93b4b-e16c-4cba-b2db-8ce8785d2404')), encoding='utf-8')
                with self.assertRaisesRegex(AssertionError, 'changed the persisted ACP or native child'):
                    self.smoke.verify_restarted_fork(root, 'parent', 'child', before)
                child.write_text(json.dumps(child_header), encoding='utf-8')
            with self.subTest(changed='ACP binding'):
                with contextlib.closing(sqlite3.connect(host_db)) as db, db:
                    db.execute('UPDATE acp_session SET session_id=? WHERE conversation_id=?', ('replacement-acp', 'child'))
                with self.assertRaisesRegex(AssertionError, 'changed the persisted ACP or native child'):
                    self.smoke.verify_restarted_fork(root, 'parent', 'child', before)

    def test_fork_requires_parent_context_and_child_continuation_in_model_requests(self):
        parent, child, restart = (self.smoke.FORK_PARENT, self.smoke.FORK_CHILD, self.smoke.FORK_RESTART)
        fixture = self.smoke.ProviderFixture()
        fixture.observe_fork_context([{'content': value} for value in (parent, child)])
        with self.assertRaisesRegex(AssertionError, 'continued child context'):
            fixture.verify_fork_context()
        fixture.observe_fork_context([{'content': value} for value in (parent, child, restart)])
        fixture.verify_fork_context()


class BundledBytecodeTests(unittest.TestCase):
    def test_direct_launcher_overrides_bytecode_opt_in_for_descendant_interpreters(self):
        with tempfile.TemporaryDirectory(prefix='studio-bytecode-') as temporary:
            root = Path(temporary)
            site = root / 'native-site'
            site.mkdir()
            (site / 'delegated_probe.py').write_text('value = 1\n')
            if os.name == 'nt':
                for name in ('win32/lib', 'Pythonwin', 'pywin32_system32'):
                    (site / name).mkdir(parents=True)
                (site / 'pywin32_bootstrap.py').write_text('')
            launcher = root / 'launch.py'
            launcher.write_bytes((ROOT / 'scripts/studio-preview/packaging/launch.py').read_bytes())
            code = ('import os,subprocess,sys; '
                    'print(subprocess.check_output([sys.executable,"-c",'
                    '"import delegated_probe,sys;print(sys.dont_write_bytecode)"],'
                    f'env=dict(os.environ,PYTHONPATH={str(site)!r})).decode().strip())')
            result = subprocess.run([sys.executable, '-I', '-S', '-B', str(launcher), 'helper', '-c', code],
                                    env=dict(os.environ, PYTHONDONTWRITEBYTECODE='0', PYTHONPYCACHEPREFIX=''),
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'True')
            self.assertEqual(list(site.rglob('*.pyc')), [])


class WindowsChildBootstrapTests(unittest.TestCase):
    def fixture(self, root):
        spec = importlib.util.spec_from_file_location('studio_bundle', ROOT / 'scripts/studio-preview/packaging/bundle.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        files = builder.write_windows_child_bootstrap(root)
        executable = root / 'python/python.exe'
        executable.write_bytes(b'owned executable identity fixture')
        spec = importlib.util.spec_from_file_location('studio_bootstrap_probe', root / files[0])
        module = importlib.util.module_from_spec(spec)
        # Keep the host test interpreter out of the automatic Windows startup gate.
        with patch.object(sys, 'orig_argv', [sys.executable, '-c', 'probe'], create=True):
            spec.loader.exec_module(module)
        fake = SimpleNamespace(platform='win32', orig_argv=[str(executable), '-m', 'aelix_coding_agent'],
                               executable=str(executable), prefix=str(root / 'python'), path=['original'])
        return builder, module, fake

    def test_owned_native_child_gets_process_local_windows_paths_without_environment_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            _, module, fake = self.fixture(root)
            environment = dict(os.environ)
            handle = object()
            for flags in ([], ['-P']):
                with self.subTest(flags=flags):
                    fake.orig_argv = [fake.executable, *flags, '-m', 'aelix_coding_agent', '--mode', 'json']
                    fake.path = ['original']
                    module._DLL_HANDLES.clear()
                    with patch.object(module, 'sys', fake), patch.object(module.os, 'add_dll_directory', return_value=handle, create=True), patch.dict(sys.modules, {'pywin32_bootstrap': ModuleType('pywin32_bootstrap')}):
                        self.assertTrue(module._configure_native_child())
                    self.assertEqual(fake.path[:3], [str(root / 'native-site' / name) for name in ('win32', 'win32/lib', 'Pythonwin')])
                    self.assertEqual(module._DLL_HANDLES, [handle])
                    self.assertEqual(dict(os.environ), environment)

    def test_project_modules_other_interpreters_and_venvs_are_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            _, module, fake = self.fixture(root)
            venv = root / 'project-venv'
            venv.mkdir()
            cases = [dict(orig_argv=[fake.executable, '-m', 'project_module']),
                     dict(orig_argv=[fake.executable, '-P', '-m', 'project_module']),
                     dict(orig_argv=[fake.executable, '-c', 'pass', '-P', '-m', 'aelix_coding_agent']),
                     dict(executable=sys.executable), dict(prefix=str(venv))]
            for changes in cases:
                candidate = SimpleNamespace(**{**vars(fake), **changes, 'path': ['original']})
                with patch.object(module, 'sys', candidate):
                    self.assertFalse(module._configure_native_child())
                self.assertEqual(candidate.path, ['original'])

    def test_existing_startup_files_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            builder, _, _ = self.fixture(root)
            with self.assertRaisesRegex(ValueError, 'existing Python startup'):
                builder.write_windows_child_bootstrap(root)

    def test_generated_pth_loads_the_owned_hook_without_bootstrapping_a_general_python_command(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.fixture(root)
            code = (f'import site,sys;site.addsitedir({str(root / "python/Lib/site-packages")!r});'
                    'print("_aelix_studio_native_bootstrap" in sys.modules)')
            result = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', code],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'True')


class InstalledPythonAliasTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('host_recovery_alias', PATH)
        self.smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.smoke)

    def test_alias_matches_the_actual_installed_file_across_windows_namespace_prefix(self):
        with tempfile.TemporaryDirectory(prefix='studio-alias-') as temporary:
            root = Path(temporary).resolve()
            installed = root / 'installed-python'
            installed.mkdir()
            (installed / 'python').write_bytes(b'owned fixture')
            target = Path('\\\\?\\' + str(installed)) if os.name == 'nt' else installed
            alias = root / 'alias'
            if os.name == 'nt':
                subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(alias), str(target)],
                               check=True, capture_output=True)
            else:
                alias.symlink_to(target, target_is_directory=True)
            self.smoke.validate_installed_python_alias(alias / 'python', target / 'python')
            if os.name == 'nt':
                alias.rmdir()

    def test_identical_bytes_in_another_runtime_are_refused(self):
        with tempfile.TemporaryDirectory(prefix='studio-alias-') as temporary:
            root = Path(temporary)
            installed, substitute = root / 'installed', root / 'substitute'
            installed.write_bytes(b'same fixture')
            substitute.write_bytes(installed.read_bytes())
            with self.assertRaisesRegex(ValueError, 'owned whitespace-free alias'):
                self.smoke.validate_installed_python_alias(substitute, installed)

    def test_whitespace_alias_is_refused_even_for_the_same_installed_file(self):
        with tempfile.TemporaryDirectory(prefix='studio-alias-') as temporary:
            root = Path(temporary)
            installed, alias = root / 'installed', root / 'alias space'
            installed.write_bytes(b'owned fixture')
            os.link(installed, alias)
            with self.assertRaisesRegex(ValueError, 'owned whitespace-free alias'):
                self.smoke.validate_installed_python_alias(alias, installed)


class NativeFailureRelayTests(unittest.TestCase):
    def fixture(self, root):
        source = ROOT / 'scripts/studio-preview/fixtures/nativeFailure.py'
        wrapper = root / 'wrapper.py'
        wrapper.write_text(source.read_text() + f'\nrun(Path({str(root)!r}), Path({str(root)!r}), Path({str(root / "extension.py")!r}), sys.argv[1:])\n')
        (root / 'launch.py').write_text('import sys,json\nfrom pathlib import Path\n'
            'sys.stdout.buffer.write(b"READY\\r\\n");sys.stdout.buffer.flush()\n'
            'for line in sys.stdin.buffer:\n'
            ' Path(__file__).with_name("received").write_bytes(line)\n'
            ' sys.stdout.buffer.write(line);sys.stdout.buffer.flush()\n')
        return wrapper

    def test_unmarked_relay_preserves_native_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wrapper = self.fixture(root)
            frame = b'{"id":1,"type":"get_state"}\n'
            result = subprocess.run([sys.executable, '-I', '-B', str(wrapper)], input=frame, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b'READY\r\n' + frame)

    def test_fail_start_never_starts_a_native_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wrapper = self.fixture(root)
            (root / 'fail-start').touch()
            result = subprocess.run([sys.executable, '-I', '-B', str(wrapper)], input=b'', capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 73)
            self.assertEqual(result.stdout, b'')

    def test_marked_downgrade_closes_the_child_without_forwarding_or_faking_a_reply(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wrapper = self.fixture(root)
            process = subprocess.Popen([sys.executable, '-I', '-B', str(wrapper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertEqual(process.stdout.readline(), b'READY\r\n')
                (root / 'fail-start').touch()
                frame = dict(id=2, type='aelix_control', method='permissions/set', params={'mode':'default'})
                output, _ = process.communicate((json.dumps(frame)+'\n').encode(), timeout=15)
                self.assertEqual((process.returncode, output), (73, b''))
                self.assertFalse((root / 'received').exists())
                self.assertEqual(json.loads((root / 'downgrade-fault.json').read_text())['forwarded'], False)
            finally:
                if process.poll() is None: process.kill();process.wait()
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream: stream.close()


class OutboundAuditTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('outbound_audit_fixture', ROOT / 'scripts/studio-preview/fixtures/outboundAudit.py')
        self.audit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.audit)

    def analyze(self, lines):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'network.1'
            trace.write_text(lines)
            return self.audit.analyze([trace])

    def test_failed_tcp_and_udp_and_loopback_dns_count_as_outbound(self):
        result = self.analyze('connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.1")}, 16) = -1 ENETUNREACH (Network unreachable)\n'
                              'sendto(3, "", 0, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ENETUNREACH (Network unreachable)\n')
        self.assertEqual(result['externalAttempts'], 2)
        self.assertEqual(result['unparsedRecords'], 0)

    def test_loopback_model_is_allowed_but_incomplete_trace_is_not(self):
        result = self.analyze('connect(3, {sa_family=AF_INET, sin_port=htons(4321), sin_addr=inet_addr("127.0.0.1")}, 16) = 0\n'
                              'connect(4,  <unfinished ...>\n')
        self.assertEqual(result['externalAttempts'], 0)
        self.assertEqual(result['unparsedRecords'], 1)


@unittest.skipIf(os.name == 'nt', 'extension generations are not offered on Windows yet (Studio #32, stage 1a\')')
class ExtensionGenerationLaunchTests(unittest.TestCase):
    """The bundled launcher adds the current extension generation to new conversations (Studio #32)."""

    GENERATION = 'g00000002-abcd'
    PREVIOUS = 'g00000001-ef01'

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='studio-launch-')
        base = Path(os.path.realpath(self.temporary.name))
        self.bundle = base / 'bundle'
        adapter = self.bundle / 'adapter-site' / 'aelix_acp'
        adapter.mkdir(parents=True)
        (adapter / '__init__.py').write_text('')
        # Stands in for the adapter: reports what it was started with, then waits when asked to.
        (adapter / 'server.py').write_text(
            'import json, os, sys\n'
            'def main():\n'
            '    print(json.dumps({"argv": sys.argv[1:], "state": os.environ.get("AELIX_STUDIO_EXTENSION_STATE")}), flush=True)\n'
            '    if os.environ.get("STUDIO_TEST_HOLD"):\n'
            '        sys.stdin.readline()\n')
        native = self.bundle / 'native-site' / 'aelix_coding_agent' / 'cli'
        native.mkdir(parents=True)
        for directory in (native.parent, native):
            (directory / '__init__.py').write_text('')
        (native / 'entry.py').write_text(
            'import json, sys\n'
            'def main_sync():\n'
            '    print(json.dumps({"argv": sys.argv, "last": sys.path[-1], "first": sys.path[0]}))\n')
        (self.bundle / 'launch.py').write_bytes((ROOT / 'scripts/studio-preview/packaging/launch.py').read_bytes())
        self.manifest = {'schema': 'aelix.studio-preview.runtime/1', 'target': 'test-target', 'python': '3.12.15',
                         'dependencyLockSha256': 'a' * 64, 'native': {'sourceTag': {'commit': 'c' * 40}}}
        (self.bundle / 'manifest.json').write_text(json.dumps(self.manifest))
        self.state = base / 'user data' / 'aelix-runtime'
        for name in ('generations', 'leases', 'artifacts'):
            (self.state / name).mkdir(parents=True)
        self.binding = {'bundle': str(self.bundle), 'target': 'test-target', 'pythonMinor': '3.12',
                        'dependencyLockSha256': 'a' * 64, 'nativeCommit': 'c' * 40}
        self.generation(self.PREVIOUS, packs=False, modules=['older_pack:setup'])
        self.generation(self.GENERATION, packs=True, modules=['legacy_pack.entry:setup'])
        self.point(self.GENERATION, self.PREVIOUS, 2)
        self.point(self.PREVIOUS, None, 1, name='current.previous.json')

    def tearDown(self):
        self.temporary.cleanup()

    def fresh(self):
        """Start a sub-test from the same state as a test."""
        self.tearDown()
        self.setUp()

    def generation(self, generation, packs, modules, binding=None):
        directory = self.state / 'generations' / generation
        (directory / 'venv' / 'lib' / 'python3.12' / 'site-packages').mkdir(parents=True)
        if packs:
            (directory / 'packs').mkdir()
        record = {'schema': 'aelix.studio.extensions.generation/2', 'generation': generation, 'parent': None,
                  'createdAt': '2026-11-18T00:00:00.000Z', 'binding': binding or self.binding,
                  'operation': {'action': 'install', 'target': 'demo'}, 'distributions': {}, 'extensions': {},
                  'launch': {'packs': packs, 'modules': modules}}
        (directory / 'generation.json').write_text(json.dumps(record))

    def point(self, generation, previous, revision, name='current.json'):
        (self.state / name).write_text(json.dumps({'schema': 'aelix.studio.extensions.current/1', 'generation': generation,
                                                    'previous': previous, 'revision': revision, 'binding': self.binding}))

    def start(self, *arguments, state=True, hold=False, mode='acp'):
        environment = dict(os.environ)
        environment.pop('AELIX_STUDIO_EXTENSION_STATE', None)
        if state:
            environment['AELIX_STUDIO_EXTENSION_STATE'] = str(self.state)
        if hold:
            environment['STUDIO_TEST_HOLD'] = '1'
        return subprocess.Popen([sys.executable, '-I', '-S', '-B', str(self.bundle / 'launch.py'), mode, *arguments],
                                env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)

    def started(self, *arguments, **options):
        process = self.start(*arguments, **options)
        output, errors = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 0, errors)
        return json.loads(output), errors

    def legacy(self, *arguments):
        return ['--aelix', sys.executable, '--aelix-arg=-I', '--aelix-arg=-S', '--aelix-arg=-B', '--aelix-arg=-Xutf8',
                '--aelix-arg=' + str(self.bundle / 'launch.py'), '--aelix-arg=native', *arguments]

    def extended(self, generation, extensions, *arguments):
        site = self.state / 'generations' / generation / 'venv' / 'lib' / 'python3.12' / 'site-packages'
        prefix = self.legacy()[:-1] + ['--aelix-arg=native-generation', '--aelix-arg=' + str(site)]
        for extension in extensions:
            prefix += ['--extension', extension]
        return prefix + list(arguments)

    def test_without_a_state_directory_the_adapter_starts_with_exactly_the_arguments_of_before(self):
        reply, _ = self.started('--profile', 'coding', state=False)
        self.assertEqual(reply['argv'], self.legacy('--profile', 'coding'))

    def test_adds_the_current_generation_and_its_extensions_and_hides_the_state_from_the_adapter(self):
        reply, errors = self.started('--profile', 'coding')
        packs = str(self.state / 'generations' / self.GENERATION / 'packs')
        self.assertEqual(reply['argv'], self.extended(self.GENERATION, [packs, 'legacy_pack.entry:setup'],
                                                      '--profile', 'coding'))
        self.assertIsNone(reply['state'])
        self.assertEqual(errors, '')

    def test_holds_a_lease_on_the_generation_for_as_long_as_the_adapter_runs(self):
        import fcntl
        process = self.start('--profile', 'coding', hold=True)
        try:
            json.loads(process.stdout.readline())
            (lease,) = list((self.state / 'leases').iterdir())
            self.assertTrue(lease.name.startswith(self.GENERATION + '.'))
            with open(lease, 'rb') as handle:
                with self.assertRaises(OSError):
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # The mutation lock itself was given back once the lease was held.
            with open(self.state / 'lock', 'rb') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            process.communicate(input='\n', timeout=30)
        # An adapter that ends normally takes its lease away instead of leaving it for clean-up.
        self.assertEqual(list((self.state / 'leases').iterdir()), [])

    def in_process(self, flock):
        """Run the launcher's generation choice in this process, with ``fcntl.flock`` replaced."""
        import fcntl
        import types
        source = (self.bundle / 'launch.py').read_text()
        namespace = {'os': os, 'sys': sys, 'Path': Path, '_LEASES': []}
        exec(compile(source[source.index('def _studio_generation'):source.index('\nroot = Path(__file__)')],
                     'launch.py', 'exec'), namespace)
        fake = types.ModuleType('fcntl')
        for name in dir(fcntl):
            setattr(fake, name, getattr(fcntl, name))
        fake.flock = flock
        with patch.dict(sys.modules, {'fcntl': fake}):
            result = namespace['_studio_generation'](self.bundle, str(self.state))
        return result, namespace['_LEASES']

    def clean_up_leases(self, flock):
        """What the helper's clean-up does to leases: remove every lease file nobody holds locked."""
        import fcntl
        for lease in (self.state / 'leases').iterdir():
            with open(lease, 'rb') as handle:
                try:
                    flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    continue
            lease.unlink()

    def test_a_lease_clean_up_finds_unlocked_never_carries_the_name_of_a_generation(self):
        import fcntl
        lock = self.state / 'lock'
        real = fcntl.flock
        calls = []

        def flock(handle, operation):
            # Between creating the lease file and locking it, a change's clean-up runs (review of
            # the launcher piece, should-fix 1). The mutation lock is left alone.
            if os.fstat(handle).st_ino != os.stat(lock).st_ino and not calls:
                calls.append('clean-up')
                self.clean_up_leases(real)
            return real(handle, operation)

        result, leases = self.in_process(flock)
        try:
            self.assertEqual(calls, ['clean-up'])
            self.assertIsNotNone(result)
            # The generation it chose has a lease under its name that clean-up finds locked, so
            # the next clean-up keeps it, and with it the generation the conversation uses.
            names = [file.name for file in (self.state / 'leases').iterdir()]
            self.assertEqual(len(names), 1, names)
            self.assertTrue(names[0].startswith(self.GENERATION + '.'), names)
            self.clean_up_leases(real)
            self.assertEqual([file.name for file in (self.state / 'leases').iterdir()], names)
        finally:
            for held in leases:
                os.close(held[1] if isinstance(held, tuple) else held)

    def test_waits_out_the_instant_the_lease_probe_holds_a_new_lease(self):
        import errno
        import fcntl
        lock = self.state / 'lock'
        refused = []

        def flock(handle, operation):
            if os.fstat(handle).st_ino != os.stat(lock).st_ino and len(refused) < 2:
                refused.append(handle)
                raise OSError(errno.EWOULDBLOCK, 'held by the probe')
            return fcntl.flock(handle, operation)

        result, leases = self.in_process(flock)
        try:
            self.assertIsNotNone(result)
            self.assertEqual(len(leases), 1)
            self.assertEqual(len(refused), 2)
        finally:
            for held in leases:
                os.close(held[1] if isinstance(held, tuple) else held)

    def test_waits_only_briefly_for_a_change_that_holds_the_lock_and_still_adds_the_generation(self):
        import fcntl
        with open(self.state / 'lock', 'wb') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            reply, _ = self.started()
        packs = str(self.state / 'generations' / self.GENERATION / 'packs')
        self.assertEqual(reply['argv'], self.extended(self.GENERATION, [packs, 'legacy_pack.entry:setup']))

    def test_falls_back_to_the_pointer_before_the_last_switch(self):
        cases = {
            'a cut pointer': lambda: (self.state / 'current.json').write_text('{"schema": "aelix.stud'),
            'a pointer to a removed generation': lambda: shutil.rmtree(self.state / 'generations' / self.GENERATION),
            'a pointer to an unfinished generation':
                lambda: (self.state / 'generations' / self.GENERATION / 'generation.json').unlink(),
            # What the helper would not read either, so both agree on the generation in effect.
            'a record of an older schema': lambda: self.edit_record(self.GENERATION, lambda value: value.update(
                schema='aelix.studio.extensions.generation/1')),
            'a module the adapter would refuse': lambda: self.edit_record(self.GENERATION, lambda value: value[
                'launch'].update(modules=['./x.py'])),
        }
        for what, damage in cases.items():
            with self.subTest(what):
                self.fresh()
                damage()
                reply, _ = self.started()
                self.assertEqual(reply['argv'], self.extended(self.PREVIOUS, ['older_pack:setup']))

    def edit_record(self, generation, edit):
        file = self.state / 'generations' / generation / 'generation.json'
        value = json.loads(file.read_text())
        edit(value)
        file.write_text(json.dumps(value))

    def test_starts_with_the_bundle_alone_when_nothing_usable_is_there(self):
        def generation_record(edit):
            for generation in (self.GENERATION, self.PREVIOUS):
                self.edit_record(generation, edit)
        cases = {
            'no pointer at all': lambda: [(self.state / name).unlink() for name in ('current.json', 'current.previous.json')],
            'both pointers damaged': lambda: [(self.state / name).write_text('[]') for name in ('current.json', 'current.previous.json')],
            'another bundle': lambda: (self.bundle / 'manifest.json').write_text(json.dumps(dict(self.manifest, dependencyLockSha256='b' * 64))),
            'an older record schema': lambda: generation_record(lambda value: value.update(schema='aelix.studio.extensions.generation/1')),
            'no extension to load': lambda: generation_record(lambda value: value.update(launch={'packs': False, 'modules': []})),
            'a missing links directory': lambda: os.rmdir(self.state / 'generations' / self.GENERATION / 'packs'),
            'generations behind a link': lambda: (shutil.move(self.state / 'generations', self.state.parent / 'moved'),
                                                  os.symlink(self.state.parent / 'moved', self.state / 'generations')),
            'a relative state directory': lambda: None,
        }
        for what, damage in cases.items():
            with self.subTest(what):
                self.fresh()
                damage()
                state = 'user data/aelix-runtime' if what == 'a relative state directory' else str(self.state)
                environment = dict(os.environ, AELIX_STUDIO_EXTENSION_STATE=state)
                process = subprocess.run([sys.executable, '-I', '-S', '-B', str(self.bundle / 'launch.py'), 'acp'],
                                         env=environment, capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
                self.assertEqual(process.returncode, 0, process.stderr)
                self.assertEqual(json.loads(process.stdout)['argv'], self.legacy())
                leases = self.state / 'leases'
                self.assertEqual(list(leases.iterdir()) if leases.is_dir() else [], [])

    def test_a_custom_native_executable_gets_neither_the_generation_nor_its_extensions(self):
        reply, _ = self.started('--aelix', '/elsewhere/aelix')
        self.assertEqual(reply['argv'], ['--aelix', '/elsewhere/aelix'])
        self.assertEqual(list((self.state / 'leases').iterdir()), [])

    def test_the_worker_form_puts_the_generation_last_on_the_import_path(self):
        site = str(self.state / 'generations' / self.GENERATION / 'venv' / 'lib' / 'python3.12' / 'site-packages')
        reply, _ = self.started(site, '--mode', 'rpc', mode='native-generation')
        self.assertEqual(reply['argv'], ['aelix', '--mode', 'rpc'])
        self.assertEqual(reply['last'], site)
        self.assertEqual(reply['first'], str(self.bundle / 'native-site'))
        refused = subprocess.run([sys.executable, '-I', '-S', '-B', str(self.bundle / 'launch.py'), 'native-generation',
                                  'relative/site', '--mode', 'rpc'], capture_output=True, text=True, timeout=30)
        self.assertNotEqual(refused.returncode, 0)
