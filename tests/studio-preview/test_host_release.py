"""Released-host smoke keeps owned paths and isolated GUI environment boundaries."""
import importlib.util
import contextlib
import os
import json
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
        smoke_spec = importlib.util.spec_from_file_location('host_fork_smoke', PATH)
        self.smoke = importlib.util.module_from_spec(smoke_spec)
        smoke_spec.loader.exec_module(self.smoke)
        self.probe_path = PATH.parent / 'probes/installedFork.py'
        probe_spec = importlib.util.spec_from_file_location('installed_fork_probe', self.probe_path)
        self.probe = importlib.util.module_from_spec(probe_spec)
        probe_spec.loader.exec_module(self.probe)

    def test_a_legacy_result_cannot_pass_the_guarded_installation_gate(self):
        self.assertEqual(self.smoke.expected_fork_mode(self.smoke.LEGACY_FORK_HOST), 'legacy')
        mode = self.smoke.expected_fork_mode('replacement-host')
        self.assertEqual(mode, 'guarded')
        with self.assertRaisesRegex(AssertionError, 'Expected the installed guarded'):
            self.smoke.verify_fork_result(mode, [self.smoke.FORK_CHECK['legacy']], [])

    def test_only_the_actual_database_distinguishes_missing_unbound_and_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with contextlib.closing(sqlite3.connect(root / 'aionui-backend.db')) as db, db:
                db.execute('CREATE TABLE acp_session (conversation_id TEXT PRIMARY KEY, session_id TEXT)')
                db.executemany('INSERT INTO acp_session VALUES (?, ?)', [('pending', None), ('child', 'real-session')])
            self.assertEqual(self.probe.observe_binding(root, 'missing'), {'found': False, 'sessionId': None})
            self.assertEqual(self.probe.observe_binding(root, 'pending'), {'found': True, 'sessionId': None})
            self.assertEqual(self.probe.observe_binding(root, 'child'), {'found': True, 'sessionId': 'real-session'})

    def test_wire_receipt_matches_the_fork_request_and_omits_other_response_data(self):
        requests = [{'id': 1, 'method': 'initialize'}, {'id': 2, 'method': 'session/fork'}]
        responses = [{'id': 1, 'error': {'code': 502, 'message': 'internal'}},
                     {'id': 2, 'error': {'code': -33003, 'message': 'internal',
                                        'data': {'kind': 'fork_head_changed', 'retryable': False}}}]
        fixture = 'import sys\nfor reply in ' + repr(responses) + ':\n sys.stdin.readline(); print(__import__("json").dumps(reply), flush=True)'
        with tempfile.TemporaryDirectory() as temporary:
            wire = Path(temporary) / 'fork.jsonl'
            result = subprocess.run([sys.executable, '-B', str(self.probe_path), 'record',
                                     str(wire), sys.executable, '-B', '-c', fixture],
                                    input=''.join(json.dumps(frame) + '\n' for frame in requests),
                                    text=True, capture_output=True, timeout=15, check=True)
            self.assertEqual([json.loads(line) for line in result.stdout.splitlines()], responses)
            self.assertEqual([json.loads(line) for line in wire.read_text().splitlines()],
                             [{'code': -33003, 'kind': 'fork_head_changed'}])


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
