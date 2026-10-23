"""Run a synthetic analysis in its own environment using only the shipped offline cache."""
import importlib.util
import os
from pathlib import Path
import platform
import site
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}[platform.machine().lower()]
RUNTIME = Path(os.environ.get('STUDIO_TEST_RUNTIME', ROOT/'resources/bundled-aelix'/f'{sys.platform}-{arch}'))
sys.path.insert(0, str(RUNTIME/'site'))
site.addsitedir(str(RUNTIME/'site'))
from aelix_analytics import extension

spec = importlib.util.spec_from_file_location('analytics_launcher', ROOT/'scripts/aelix-studio/runtimeLauncher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class AnalyticsTests(unittest.IsolatedAsyncioTestCase):
    async def test_synthetic_analysis_and_html_render_without_installed_tools_or_network(self):
        with tempfile.TemporaryDirectory(prefix='studio-analytics-') as tmp:
            root = Path(tmp)
            environment = launcher.analytics_environment(RUNTIME, root/'state/analytics')
            environment.update(HOME=tmp, USERPROFILE=tmp, UV_OFFLINE='1',
                               PATH=str(RUNTIME/'bin'), APPDATA=str(root/'appdata'),
                               LOCALAPPDATA=str(root/'local'),
                               UV_PYTHON=str(RUNTIME/('python/python.exe' if sys.platform == 'win32' else 'python/bin/python3')),
                               AELIX_ANALYTICS_SESSION='studio-synthetic-test')
            with patch.dict(os.environ, environment):
                project = extension.core.init_project(root/'project',
                    origin=extension.core.Origin('agent', 'tool', 'declared', 'studio-synthetic-test'))
                synced, detail = await extension.sync_environment(project)
                self.assertTrue(synced, detail)
                ok, result = await extension.run_kit(project, ['demo'], timeout=180)
                self.assertTrue(ok, result)
                rendered, report = await extension.run_kit(project, ['render'], timeout=120)
                self.assertTrue(rendered, report)
            self.assertTrue((project.workspace_dir/'index.html').is_file())
            self.assertGreater((project.workspace_dir/'index.html').stat().st_size, 1000)
            self.assertTrue((root/'project/.venv').is_dir())


if __name__ == '__main__':
    unittest.main()
