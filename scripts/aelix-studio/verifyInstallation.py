"""Install, execute, reinstall and remove a disposable Windows/Linux package.

Run only on an isolated CI host. Uses a private app-data fixture and verifies
installed bytes, packaged renderer startup and both relocated ACP profiles.
Reinstall acceptance is not a different-version data migration claim.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def run(argv, **kwargs):
    subprocess.run([str(a) for a in argv], check=True, timeout=240, **kwargs)


def windows_installer(installer, destination, env):
    # NSIS /D consumes the unquoted remainder and must be the last switch.
    line = subprocess.list2cmdline([str(installer), '/S']) + ' /D=' + str(destination)
    subprocess.run(line, check=True, timeout=240, env=env)


def close_windows_app(executable, env):
    scoped = dict(env, STUDIO_ACCEPT_APP_EXE=str(executable))
    run(['powershell', '-NoProfile', '-Command',
         'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:STUDIO_ACCEPT_APP_EXE } | '
         'ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }'], env=scoped)


def main():
    if sys.platform not in ('win32', 'linux'):
        raise SystemExit('Use a disposable Windows or Linux CI host')
    candidates = list((ROOT/'out').glob('*.exe' if sys.platform == 'win32' else '*.deb'))
    if len(candidates) != 1:
        raise RuntimeError('Expected exactly one installer')
    package = candidates[0].resolve()
    report = {'schema': 'studio.install-acceptance/1', 'platform': sys.platform,
              'architecture': platform.machine(), 'installerSha256': hashlib.sha256(package.read_bytes()).hexdigest(),
              'checks': [], 'passed': False, 'scope': 'clean install / same-version reinstall / uninstall; isolated fixture data'}
    expected = json.loads((ROOT/'scripts/aelix-studio/runtime.json').read_text())
    with tempfile.TemporaryDirectory(prefix='Studio 한글 package ') as tmp:
        private = Path(tmp)
        userdata = private/'user data'
        userdata.mkdir()
        fixture = userdata/'preserve.txt'
        fixture.write_text('PRESERVE_USER_DATA', encoding='utf-8')
        env = dict(os.environ, E2E_PACKAGED='1', AIONUI_E2E_USER_DATA_DIR=str(userdata))
        installed = False
        try:
            if sys.platform == 'win32':
                location = private/'Installed App'
                windows_installer(package, location, env)
                executable = location/'Aelix Studio.exe'
                installed = True
            else:
                run(['sudo', 'apt-get', 'install', '-y', package])
                installed = True
                name = subprocess.check_output(['dpkg-deb', '-f', str(package), 'Package'], text=True).strip()
                files = subprocess.check_output(['dpkg', '-L', name], text=True).splitlines()
                executable, = [Path(p) for p in files if p.endswith('/Aelix Studio') and Path(p).is_file()]
                location = executable.parent
            if not executable.is_file():
                raise RuntimeError('Installed executable is missing')
            report['checks'].append('clean_install')
            target = 'win32-x64' if sys.platform == 'win32' else ('linux-arm64' if platform.machine() == 'aarch64' else 'linux-x64')
            runtime = location/'resources/bundled-aelix'/target
            manifest = json.loads((runtime/'manifest.json').read_text(encoding='utf-8'))
            if manifest['acp']['commit'] != expected['acp']['commit'] or manifest['aelix'] != '0.1.0b2':
                raise RuntimeError('Installed runtime provenance does not match the candidate')
            report['acpCommit'] = manifest['acp']['commit']
            run([sys.executable, ROOT/'scripts/aelix-studio/smokeRuntime.py', runtime, '--relocate'], env=env)
            report['checks'].append('installed_both_profiles_after_unicode_relocation')
            env['E2E_PACKAGED_APP_PATH'] = str(executable)
            command = ['bun', 'x', 'playwright', 'test', 'tests/e2e/specs/app-launch.e2e.ts']
            run(command if sys.platform == 'win32' else ['xvfb-run', '-a', *command], cwd=ROOT, env=env)
            report['checks'].append('installed_renderer_launch')
            inventory = json.loads((runtime/'checksums.json').read_text(encoding='utf-8'))
            for relative, digest in inventory.items():
                if hashlib.sha256((runtime/relative).read_bytes()).hexdigest() != digest:
                    raise RuntimeError('Installed runtime changed during launch: ' + relative)
            report['checks'].append('installed_bytes_unchanged_after_launch')
            if sys.platform == 'win32':
                close_windows_app(executable, env)
                windows_installer(package, location, env)
            else:
                run(['sudo', 'apt-get', 'install', '--reinstall', '-y', package])
            if fixture.read_text(encoding='utf-8') != 'PRESERVE_USER_DATA' or not executable.is_file():
                raise RuntimeError('Reinstall did not preserve the test user data')
            report['checks'].append('reinstall_preserves_user_data')
            if sys.platform == 'win32':
                close_windows_app(executable, env)
                uninstallers = list(location.glob('Uninstall*.exe'))
                if len(uninstallers) != 1:
                    raise RuntimeError('Installed uninstaller is missing')
                run([uninstallers[0], '/S'], env=env)
            else:
                run(['sudo', 'dpkg', '--remove', name])
            deadline = time.monotonic() + 60
            while executable.exists() and time.monotonic() < deadline:
                time.sleep(.2)
            if executable.exists() or fixture.read_text(encoding='utf-8') != 'PRESERVE_USER_DATA':
                raise RuntimeError('Uninstall did not remove the executable while retaining the user fixture')
            installed = False
            report['checks'].append('uninstall_preserves_user_data')
            report['passed'] = True
        except BaseException as exc:
            report['error'] = str(exc)
            raise
        finally:
            if sys.platform == 'win32' and installed:
                close_windows_app(executable, env)
            report['cleanupRequired'] = installed
            (ROOT/'out/install-acceptance.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
