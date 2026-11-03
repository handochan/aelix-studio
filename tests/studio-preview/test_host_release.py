"""Released-host smoke keeps owned paths and isolated GUI environment boundaries."""
import importlib.util
import os
import json
import sys
import subprocess
from pathlib import Path
import tempfile
import unittest

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
            'print("READY",flush=True)\n'
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
            self.assertEqual(result.stdout, b'READY\n' + frame)

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
                self.assertEqual(process.stdout.readline(), b'READY\n')
                (root / 'fail-start').touch()
                frame = dict(id=2, type='aelix_control', method='permissions/set', params={'mode':'default'})
                output, _ = process.communicate((json.dumps(frame)+'\n').encode(), timeout=15)
                self.assertEqual((process.returncode, output), (73, b''))
                self.assertFalse((root / 'received').exists())
                self.assertEqual(json.loads((root / 'downgrade-fault.json').read_text())['forwarded'], False)
            finally:
                if process.poll() is None: process.kill();process.wait()
