"""Mount an acceptance DMG, install its app in a disposable Unicode/space path and run the real UI.

This uses a synthetic provider in CI. Real-account runs are kept separate and never use CI secrets.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[3]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(args):
    runtime = Path(args.runtime).resolve()
    dmg = Path(args.dmg).resolve()
    output = ROOT / '.local/provider-installer/acceptance.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'status': 'running'}) + '\n')
    applications = Path.home() / 'Applications'
    applications.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='Studio Provider 한글-', dir=applications) as installed:
        directory = Path(installed)
        mount = directory / 'mount'
        mount.mkdir()
        subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(dmg)], check=True, stdout=subprocess.DEVNULL)
        app = directory / 'AionUi.app'
        try:
            subprocess.run(['ditto', str(mount / 'AionUi.app'), str(app)], check=True)
        finally:
            subprocess.run(['hdiutil', 'detach', str(mount)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        payload = app / 'Contents/Resources/studio-preview'
        manifest = json.loads((payload / 'manifest.json').read_text())
        if manifest['target'] != 'darwin-arm64' or manifest['nativePatches']:
            raise ValueError('Unsupported installed runtime')
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
        # Python/ACP must launch with source and original interpreter trees denied.
        blocked = [str(runtime), str(ROOT / 'packages'), str(ROOT / 'scripts'), str(ROOT / 'out')]
        base = subprocess.check_output([str(runtime / 'native/bin/python'), '-I', '-B', '-c', 'import sys;print(sys.base_prefix)'], text=True).strip()
        blocked.append(base)
        profile = '(version 1) (allow default) ' + ''.join('(deny file-read* (subpath ' + json.dumps(path) + ')) ' for path in blocked)
        environment = dict(os.environ, PATH='/usr/bin:/bin', PYTHONDONTWRITEBYTECODE='1')
        probe = subprocess.check_output(['/usr/bin/sandbox-exec', '-p', profile, str(payload / 'native/bin/python'), '-I', '-B', '-c',
            'import aelix_ai,aelix_coding_agent,sys,json;print(json.dumps(dict(bundled=".app/Contents/Resources/studio-preview/" in sys.executable)))'], env=environment, text=True)
        if not json.loads(probe)['bundled']:
            raise ValueError('Installed Python escaped its bundle')
        subprocess.run(['/usr/bin/sandbox-exec', '-p', profile, str(payload / 'adapter/bin/aelix-acp'), '--help'], env=environment,
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        environment['PROVIDER_APP_EXECUTABLE'] = str(app / 'Contents/MacOS/AionUi')
        # The outer Electron process retains its normal Chromium sandbox. Only the standalone
        # runtime probes above use sandbox-exec; nesting Chromium in another seatbelt fails on macOS.
        environment['PATH'] = os.environ['PATH']
        subprocess.run([str(runtime / 'native/bin/python'), '-B', str(Path(__file__).parents[1] / 'providerSmoke.py'), '--runtime', str(runtime)],
                       check=True, cwd=ROOT, env=environment, timeout=300)
        report = dict(status='passed', target='darwin-arm64', dmgSha256=digest(dmg), dmgBytes=dmg.stat().st_size,
                      qualifierSha256=digest(Path(__file__)), installedRuntimeManifestSha256=digest(payload / 'manifest.json'),
                      mountedDmgCopy=True, unicodeAndSpaceInstallPath=True, adHocSignatureVerified=True,
                      developerId=False, notarized=False, installedNativeWheelMembers=checked, nativePatches=[],
                      standaloneRuntimeSourceDenied=True, systemNodePythonNotUsedByRuntime=True,
                      installedUi=json.loads((ROOT / '.local/studio-provider/host.json').read_text()),
                      cleanOSAccount=False, crossVersionUpgrade=False)
        # Uninstall only this owned disposable test app; native user-state acceptance is separate.
        shutil.rmtree(app)
        report['ownedTestAppRemoved'] = not app.exists()
        output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--dmg', required=True)
    try:
        main(parser.parse_args())
    except BaseException:
        output = ROOT / '.local/provider-installer/acceptance.json'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({'status': 'failed'}) + '\n')
        raise
