"""Install/extract the current host artifact in an owned Unicode/space path and exercise the real UI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import zipfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parents[1]))
from prepare import host_target, venv_path
sys.path.insert(0, str(Path(__file__).parents[1] / 'host-recovery'))
from identity import host_identity, macho_code_identity


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()



def long_path(path):
    path = Path(path).resolve()
    value = str(path)
    if os.name == 'nt' and not value.startswith('\\\\?\\'):
        return Path('\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value)
    return path


def installed(artifact, directory):
    """Return executable/payload/app/format after installing only the owned candidate."""
    if sys.platform == 'darwin':
        mount = directory / 'mount'
        mount.mkdir()
        subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(artifact)],
                       check=True, stdout=subprocess.DEVNULL)
        app = directory / 'AionUi.app'
        try:
            subprocess.run(['ditto', str(mount / 'AionUi.app'), str(app)], check=True)
        finally:
            subprocess.run(['hdiutil', 'detach', str(mount)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        return app / 'Contents/MacOS/AionUi', app / 'Contents/Resources/studio-preview', app, 'dmg', None
    if sys.platform == 'win32':
        # Refuse an existing real installation or running desktop before NSIS
        # can change its per-user registration or request another app's exit.
        import winreg
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for view in (0, winreg.KEY_WOW64_32KEY):
                try:
                    key = winreg.OpenKey(hive, r'Software\Microsoft\Windows\CurrentVersion\Uninstall', 0, winreg.KEY_READ | view)
                except OSError:
                    continue
                with key:
                    for index in range(winreg.QueryInfoKey(key)[0]):
                        try:
                            with winreg.OpenKey(key, winreg.EnumKey(key, index)) as entry:
                                if str(winreg.QueryValueEx(entry, 'DisplayName')[0]).lower().startswith('aionui'):
                                    raise ValueError('Refusing to replace an existing AionUi installation')
                        except OSError:
                            continue
        processes = subprocess.check_output(['tasklist', '/FI', 'IMAGENAME eq AionUi.exe', '/FO', 'CSV', '/NH'])
        if b'aionui.exe' in processes.lower():
            raise ValueError('Refusing to interrupt an existing AionUi process')
        app = directory / 'AionUi'
        # NSIS /D is the final, unquoted tail. CreateProcess receives this command
        # directly (no cmd/shell), preserving spaces and Unicode without expansion.
        subprocess.run('"' + str(artifact) + '" /S /D=' + str(app), check=True, timeout=300, shell=False)
        return app / 'AionUi.exe', long_path(app / 'resources/studio-preview'), app, 'nsis', None
    package = subprocess.check_output(['dpkg-deb', '--field', str(artifact), 'Package'], text=True).strip()
    if not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', package):
        raise ValueError('Invalid Debian package identity')
    existing = subprocess.run(['dpkg-query', '-W', package], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if existing.returncode == 0:
        raise ValueError('Refusing to replace an existing desktop package')
    subprocess.run(['sudo', '-n', 'apt-get', 'install', '-y', str(artifact)], check=True, timeout=300)
    files = subprocess.check_output(['dpkg', '-L', package], text=True).splitlines()
    manifests = [Path(file) for file in files if file.endswith('/resources/studio-preview/manifest.json')]
    if len(manifests) != 1:
        subprocess.run(['sudo', '-n', 'apt-get', 'remove', '-y', package], check=True, timeout=120)
        raise ValueError('Installed Debian package has no unique runtime manifest')
    payload = manifests[0].parent
    app = payload.parent.parent
    executable = app / 'aionui'
    if not executable.is_file():
        executable = app / 'AionUi'
    return executable, payload, app, 'deb', package


def remove_install(app, kind, package):
    if kind == 'nsis':
        uninstallers = list(app.glob('*ninstall*.exe'))
        if len(uninstallers) != 1:
            raise ValueError('Owned NSIS uninstaller is missing')
        subprocess.run('"' + str(uninstallers[0]) + '" /S _?=' + str(app),
                       check=True, timeout=120, shell=False)
    if package:
        subprocess.run(['sudo', '-n', 'apt-get', 'remove', '-y', package], check=True, timeout=120)
    elif app.exists():
        shutil.rmtree(long_path(app))


def main(args):
    runtime = Path(args.runtime).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'status': 'running'}) + '\n', encoding='utf-8')
    if sys.platform == 'linux' and os.geteuid() == 0:
        raise ValueError('Run the GUI qualifier as an unprivileged user')
    artifact = args.artifact or args.dmg
    if artifact:
        artifact = Path(artifact).resolve()
    else:
        suffix = { 'darwin': '*.dmg', 'win32': '*.exe', 'linux': '*.deb' }[sys.platform]
        matches = [p for p in Path(args.artifacts).resolve().glob(suffix) if 'uninstall' not in p.name.lower()]
        if len(matches) != 1:
            raise ValueError('Expected one current-host installer artifact')
        artifact = matches[0]
    if sys.platform == 'darwin':
        applications = Path.home() / 'Applications'
        applications.mkdir(exist_ok=True)
    else:
        applications = None
    with tempfile.TemporaryDirectory(prefix='Studio Provider 한글-', dir=applications) as temporary:
        directory = Path(temporary).resolve()
        executable, payload, app, kind, package = installed(artifact, directory)
        try:
            if not executable.is_file():
                raise ValueError('Installer did not produce its expected executable')
            manifest = json.loads((payload / 'manifest.json').read_text(encoding='utf-8'))
            target = host_target()
            if manifest['target'] != target or manifest['nativePatches']:
                raise ValueError('Unsupported installed runtime')
            prepared = json.loads((runtime / 'receipt.json').read_text(encoding='utf-8'))
            core = payload.parent / 'bundled-aioncore' / target / ('aioncore.exe' if sys.platform == 'win32' else 'aioncore')
            original_core = runtime / prepared['aioncoreBinary']
            identity = dict(expectedOriginalSha256=prepared['aioncoreBinarySha256'],
                            observedOriginalSha256=digest(original_core), installedSha256=digest(core),
                            original={}, installed={})
            identity_path = output.with_name('aioncore-identity.json')
            identity_path.write_text(json.dumps(identity, indent=2) + '\n', encoding='utf-8')
            if identity['observedOriginalSha256'] != identity['expectedOriginalSha256']:
                raise ValueError('Qualified original AionCore artifact bytes changed')
            identity['originalCodeSha256'] = host_identity(original_core, identity['original'])
            identity['installedCodeSha256'] = host_identity(core, identity['installed'])
            identity_path.write_text(json.dumps(identity, indent=2) + '\n', encoding='utf-8')
            if identity['originalCodeSha256'] != identity['installedCodeSha256']:
                raise ValueError('Installed AionCore code differs from the declared artifact')
            checked = 0
            for spec in manifest['native']['wheels']:
                wheel = runtime / 'wheels' / spec['filename']
                if digest(wheel) != spec['sha256']:
                    raise ValueError('Original public artifact changed')
                with zipfile.ZipFile(wheel) as archive:
                    for member in archive.infolist():
                        if member.is_dir() or member.filename.endswith('.dist-info/RECORD'):
                            continue
                        if (payload / 'native-site' / member.filename).read_bytes() != archive.read(member):
                            raise ValueError('Installed native wheel member changed')
                        checked += 1
            probe_payload = payload
            if sys.platform == 'linux':
                probe_payload = directory / 'relocated runtime 한글'
                shutil.copytree(payload, probe_payload, symlinks=True)
            python = probe_payload / ('python/python.exe' if sys.platform == 'win32' else 'python/bin/python3')
            loader = probe_payload / 'launch.py'
            isolated = [str(python), '-I', '-S', '-B', '-X', 'utf8', str(loader)]
            wrapper = []
            if sys.platform == 'darwin':
                base = subprocess.check_output([str(venv_path(runtime, 'native')), '-I', '-B', '-c',
                                                'import sys;print(sys.base_prefix)'], text=True).strip()
                blocked = [str(runtime), str(ROOT / 'packages'), str(ROOT / 'scripts'), str(ROOT / 'out'), base]
                profile = '(version 1) (allow default) ' + ''.join(
                    '(deny file-read* (subpath ' + json.dumps(path) + ')) ' for path in blocked)
                wrapper = ['/usr/bin/sandbox-exec', '-p', profile]
            system_path = (os.environ.get('SystemRoot', os.environ.get('SYSTEMROOT', r'C:\Windows')) + r'\System32;'
                           + os.environ.get('SystemRoot', os.environ.get('SYSTEMROOT', r'C:\Windows'))
                           if sys.platform == 'win32' else '/usr/bin:/bin')
            environment = dict(os.environ, PATH=system_path, PYTHONDONTWRITEBYTECODE='1')
            probe_code = textwrap.dedent("""
    import os,sys,json
    from pathlib import Path
    import aelix_ai,aelix_coding_agent
    def owned(value):
        value=str(Path(value).resolve())
        if sys.platform=='win32' and not value.startswith('\\\\\\\\?\\\\'):
            value='\\\\\\\\?\\\\UNC\\\\'+value[2:] if value.startswith('\\\\\\\\') else '\\\\\\\\?\\\\'+value
        return Path(value)
    root=owned(ROOT_VALUE)
    assert owned(sys.executable).is_relative_to(root)
    assert all(owned(module.__file__).is_relative_to(root) for module in (aelix_ai,aelix_coding_agent))
    assert sys.flags.isolated and sys.flags.no_site and sys.flags.no_user_site
    if sys.platform=='win32':
        import win32api,pywintypes
        assert all(owned(module.__file__).is_relative_to(root) for module in (win32api,pywintypes))
    print(json.dumps(dict(bundled=True,isolated=True)))
    """).replace('ROOT_VALUE', repr(str(probe_payload)))
            probe = subprocess.check_output([*wrapper, *isolated, 'helper', '-c', probe_code],
                                            env=environment, text=True, encoding='utf-8', timeout=30)
            if not json.loads(probe)['bundled']:
                raise ValueError('Installed Python escaped its bundle')
            subprocess.run([*wrapper, *isolated, 'acp', '--version'], env=environment,
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            environment['PROVIDER_APP_EXECUTABLE'] = str(executable)
            # The qualifier itself uses development Node; the installed app receives a
            # system-only PATH in providerHostSmoke and retains its Chromium sandbox.
            environment['PATH'] = os.environ['PATH']
            subprocess.run([str(venv_path(runtime, 'native')), '-B', str(Path(__file__).parents[1] / 'providerSmoke.py'),
                            '--runtime', str(runtime), '--helper-runtime', str(payload)],
                           check=True, cwd=ROOT, env=environment, timeout=420)
            permission_output = output.parent / 'permission/qualification.json'
            subprocess.run([str(venv_path(runtime, 'native')), '-B', str(Path(__file__).parents[1] / 'host-recovery/smoke.py'),
                            '--runtime', str(runtime), '--payload', str(payload), '--report', str(permission_output)],
                           check=True, cwd=ROOT, env=environment, timeout=420)
            permission = json.loads(permission_output.read_text(encoding='utf-8'))
            if permission['status'] != 'passed' or not permission['installer'] or permission['defaultHostOverride']:
                raise ValueError('Installed default host permission acceptance failed')
            report = dict(status='passed', target=target, permissionChecks=permission['checksPassed'], permissionReportSha256=digest(permission_output), artifactKind=kind, artifactSha256=digest(artifact),
                          artifactBytes=artifact.stat().st_size, qualifierSha256=digest(Path(__file__)),
                          installedRuntimeManifestSha256=digest(payload / 'manifest.json'),
                          installedAioncoreSha256=digest(core),
                          aioncoreCodeIdentityMatched=True, originalAioncoreSha256=prepared['aioncoreBinarySha256'],
                          aioncoreIdentity=identity,
                          unicodeAndSpaceInstallPath=sys.platform != 'linux', unicodeAndSpaceRuntimeRelocation=True,
                          unicodeAndSpaceUserState=True, adHocSignatureVerified=sys.platform == 'darwin',
                          developerId=False, notarized=False, installedNativeWheelMembers=checked, nativePatches=[],
                          standaloneRuntimeSourceDenied=sys.platform == 'darwin', standaloneIsolatedOwnedImports=True,
                          systemNodePythonNotUsedByRuntime=True, guiRestrictedPath=True,
                          installedUi=json.loads((ROOT / '.local/studio-provider/host.json').read_text(encoding='utf-8')),
                          cleanOSAccount=False, crossVersionUpgrade=False)
            if kind == 'dmg':
                report.update(dmgSha256=report['artifactSha256'], dmgBytes=report['artifactBytes'], mountedDmgCopy=True)
        finally:
            remove_install(app, kind, package)
        report['ownedTestAppRemoved'] = not app.exists()
        if not report['ownedTestAppRemoved']:
            raise ValueError('Owned installer files remain after cleanup')
        output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--artifact')
    parser.add_argument('--dmg')
    parser.add_argument('--artifacts', default=str(ROOT / '.local/provider-installer/artifacts'))
    parser.add_argument('--output', default=str(ROOT / '.local/provider-installer/acceptance.json'))
    args = parser.parse_args()
    try:
        main(args)
    except BaseException:
        output = Path(args.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({'status': 'failed', 'target': host_target()}) + '\n', encoding='utf-8')
        raise
