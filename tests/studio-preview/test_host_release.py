"""Released-host smoke keeps owned paths and isolated GUI environment boundaries."""
import importlib.util
import os
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
