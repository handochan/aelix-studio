#!/usr/bin/env python3
"""Build the host-native, relocatable Aelix runtime. Build-time network/uv required."""
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((Path(__file__).with_name('runtime.json')).read_text())

def run(*args):
    subprocess.run([str(a) for a in args], check=True)

def main():
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64'}.get(platform.machine())
    target = f'{sys.platform}-{arch}'
    if target not in CONFIG['supportedBuildTargets']:
        raise SystemExit(f'Unsupported runtime target: {target}; Windows permission transport is pending.')
    uv = shutil.which('uv')
    if not uv:
        raise SystemExit('Build prerequisite missing: uv (not required by installed applications).')
    (ROOT / '.local').mkdir(exist_ok=True)
    destination = ROOT / 'resources' / 'bundled-aelix' / target
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='aelix-build-', dir=ROOT / '.local') as tmp:
        staging = Path(tmp)
        bundle = staging / 'runtime'
        bundle.mkdir()
        # uv validates the managed Python download against its embedded checksums.
        run(uv, 'python', 'install', CONFIG['python'], '--no-bin', '--install-dir', staging/'python')
        installations = [p for p in (staging/'python').glob('cpython-*') if p.is_dir() and not p.is_symlink()]
        if len(installations) != 1:
            raise RuntimeError('Expected exactly one managed Python installation')
        shutil.move(installations[0], bundle/'python')
        python = bundle/'python/bin/python3'
        run(uv, 'pip', 'install', '--python', python, '--target', bundle/'site', '--only-binary=:all:',
            '--require-hashes', '-r', Path(__file__).with_name('requirements.lock'))
        acp = CONFIG['acp']
        url = f"https://codeload.github.com/{acp['repository']}/tar.gz/{acp['commit']}"
        archive = staging/'acp.tar.gz'
        urllib.request.urlretrieve(url, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != acp['archiveSha256']:
            raise RuntimeError('ACP source checksum mismatch')
        with tarfile.open(archive) as tar:
            # Only package source and its notices, never a developer's checkout/state.
            prefix = f"aelix-acp-{acp['commit']}/"
            for member in tar.getmembers():
                relative = member.name.removeprefix(prefix)
                if member.isfile() and (relative.startswith('src/aelix_acp/') or relative in ('LICENSE', 'NOTICE')):
                    content = tar.extractfile(member).read()
                    if relative.startswith('src/'):
                        dest = bundle/'site'/relative.removeprefix('src/')
                    else:
                        dest = bundle/'licenses'/f'acp-{relative}'
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(content)
        shutil.copy(Path(__file__).with_name('runtimeLauncher.py'), bundle/'launch.py')
        (bundle/'bin').mkdir()
        for command, mode in [('aelix', 'aelix'), ('aelix-acp', 'acp')]:
            launcher = bundle/'bin'/command
            launcher.write_text('#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\n'
                                f'exec "$ROOT/python/bin/python3" -I "$ROOT/launch.py" {mode} "$@"\n')
            launcher.chmod(0o755)
        packages = json.loads(subprocess.check_output([str(python), '-I', '-c',
            'import importlib.metadata as m,json,sys; print(json.dumps(sorted([dict(name=d.metadata["Name"],version=d.version) for d in m.distributions(path=[sys.argv[1]])],key=lambda p:p["name"])))', str(bundle/'site')]))
        receipt = dict(CONFIG, target=target, packages=packages,
                       uvVersion=subprocess.check_output([uv, '--version'], text=True).strip(),
                       dependencyLockSha256=hashlib.sha256(Path(__file__).with_name('requirements.lock').read_bytes()).hexdigest())
        (bundle/'manifest.json').write_text(json.dumps(receipt, indent=2)+'\n')
        # Inventory every shipped byte. License files from wheel .dist-info and Python stay in place.
        inventory = {str(p.relative_to(bundle)): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(bundle.rglob('*')) if p.is_file()}
        (bundle/'checksums.json').write_text(json.dumps(inventory, indent=2)+'\n')
        # Preserve the last good bundle until every preparation step succeeds.
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(bundle, destination)
    print(f'Runtime prepared: {destination}')

if __name__ == '__main__':
    main()
