#!/usr/bin/env python3
"""Build the host-native, relocatable Aelix runtime. Build-time network/uv required."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import importlib.util

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((Path(__file__).with_name('runtime.json')).read_text())

def run(*args, env=None):
    subprocess.run([str(a) for a in args], check=True, env=env)

def managed_python(install_dir, version):
    """Select the exact patch installation, excluding uv's minor-version junction alias."""
    installations = [p for p in Path(install_dir).glob(f'cpython-{version}-*')
                     if p.is_dir() and not p.is_symlink()]
    if len(installations) != 1:
        raise RuntimeError(f'Expected exactly one managed Python {version} installation')
    return installations[0]

def prepare_analytics(uv, python, bundle, staging):
    """Build the pinned extension and cache its separate project environment for offline use."""
    config = CONFIG['analytics']
    archive = staging/'analytics.tar.gz'
    urllib.request.urlretrieve(
        f"https://codeload.github.com/{config['repository']}/tar.gz/{config['commit']}", archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != config['archiveSha256']:
        raise RuntimeError('Analytics source checksum mismatch')
    source = staging/'analytics-source'
    prefix = f"{config['repository'].split('/')[-1]}-{config['commit']}/"
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            relative = member.name.removeprefix(prefix)
            if (not member.name.startswith(prefix) or not member.isfile()
                    or '..' in Path(relative).parts):
                continue
            if relative.startswith('src/aelix_analytics/') or relative in (
                    'extension/aelix_analytics.py', 'pyproject.toml', 'README.md', 'LICENSE'):
                dest = source/relative
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(tar.extractfile(member).read())
    wheels = staging/'analytics-wheels'
    run(uv, 'build', '--wheel', '--python', python, '--out-dir', wheels, source)
    wheel, = wheels.glob('*.whl')
    run(uv, 'pip', 'install', '--python', python, '--target', bundle/'site', '--no-deps', wheel)
    (bundle/'bin').mkdir(exist_ok=True)
    shutil.copy2(Path(uv).resolve(), bundle/'bin'/('uv.exe' if sys.platform == 'win32' else 'uv'))
    for license_name in ('LICENSE-MIT', 'LICENSE-APACHE'):
        dest = bundle/'licenses'/f'uv-{license_name}'
        dest.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(
            f"https://raw.githubusercontent.com/astral-sh/uv/{CONFIG['uv']}/{license_name}", dest)
    project = staging/'analytics-environment'
    project.mkdir()
    for name in ('pyproject.toml', 'uv.lock'):
        shutil.copy(Path(__file__).with_name('analytics')/name, project/name)
    environment = {k: v for k, v in os.environ.items() if not k.startswith(('UV_', 'PIP_'))}
    environment.update(UV_CACHE_DIR=str(bundle/'analytics-cache'), UV_PYTHON_DOWNLOADS='never',
                       UV_NO_CONFIG='1', UV_DEFAULT_INDEX='https://pypi.org/simple', UV_LINK_MODE='copy')
    run(uv, 'sync', '--project', project, '--locked', '--no-dev', '--python', python, env=environment)
    # A locked sync downloads wheels without caching the registry metadata needed to
    # resolve a newly initialized Analytics project. Prime only the locked versions.
    pins = json.loads(subprocess.check_output([str(python), '-I', '-c',
        'import json,sys,tomllib; d=tomllib.load(open(sys.argv[1],"rb")); '
        'print(json.dumps([p["name"]+"=="+p["version"] for p in d["package"] if "registry" in p.get("source",{})]))',
        str(project/'uv.lock')]))
    primer = staging/'analytics-cache-primer'
    primer.mkdir()
    (primer/'pyproject.toml').write_text('[project]\nname="studio-cache-primer"\nversion="0.0.0"\n'
        'requires-python="==3.12.*"\ndependencies=' + json.dumps(pins) + '\n[tool.uv]\npackage=false\n')
    run(uv, 'lock', '--project', primer, '--python', python, env=environment)
    # Cache links must survive relocating the bundle. Windows junctions do not support relative targets.
    for link in list((bundle/'analytics-cache').rglob('*')):
        junction = getattr(link, 'is_junction', lambda: False)()
        if not link.is_symlink() and not junction:
            continue
        target = link.resolve()
        if not target.is_relative_to(bundle.resolve()):
            raise RuntimeError(f'Analytics cache link escapes the bundle: {link}')
        if junction:
            link.rmdir()
            shutil.copytree(target, link)
        else:
            link.unlink()
            link.symlink_to(os.path.relpath(target, link.parent), target_is_directory=target.is_dir())

def main():
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine().lower())
    target = f'{sys.platform}-{arch}'
    if target not in CONFIG['supportedBuildTargets']:
        raise SystemExit(f'Unsupported runtime target: {target}; build on a supported native host.')
    uv = shutil.which('uv')
    if not uv:
        raise SystemExit('Build prerequisite missing: uv (not required by installed applications).')
    uv_version = subprocess.check_output([uv, '--version'], text=True).strip()
    if uv_version.split()[1] != CONFIG['uv']:
        raise SystemExit(f"Build requires uv {CONFIG['uv']}; found {uv_version}")
    (ROOT / '.local').mkdir(exist_ok=True)
    destination = ROOT / 'resources' / 'bundled-aelix' / target
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='aelix-build-', dir=ROOT / '.local') as tmp:
        staging = Path(tmp)
        bundle = staging / 'runtime'
        if sys.platform == 'win32':
            spec = importlib.util.spec_from_file_location('studio_paths', Path(__file__).with_name('runtimeLauncher.py'))
            launcher = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(launcher)
            bundle = launcher.long_path(bundle)
        bundle.mkdir()
        # uv validates the managed Python download against its embedded checksums.
        run(uv, 'python', 'install', CONFIG['python'], '--no-bin', '--no-registry', '--install-dir', staging/'python')
        shutil.move(managed_python(staging/'python', CONFIG['python']), bundle/'python')
        python = bundle/('python/python.exe' if sys.platform == 'win32' else 'python/bin/python3')
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
        compatibility = Path(__file__).with_name('compatibility')
        shutil.copy(Path(__file__).with_name('runtimeLauncher.py'), bundle/'launch.py')
        shutil.copy(compatibility/'launcher.cjs', bundle/'launch.cjs')
        prepare_analytics(uv, python, bundle, staging)
        (bundle/'bin').mkdir(exist_ok=True)
        for command, mode in ([] if sys.platform == 'win32' else [('aelix', 'aelix'), ('aelix-acp', 'acp')]):
            launcher = bundle/'bin'/command
            launcher.write_text('#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\n'
                                f'exec "$ROOT/python/bin/python3" -I -B "$ROOT/launch.py" {mode} "$@"\n')
            launcher.chmod(0o755)
        packages = json.loads(subprocess.check_output([str(python), '-I', '-c',
            'import importlib.metadata as m,json,sys; print(json.dumps(sorted([dict(name=d.metadata["Name"],version=d.version) for d in m.distributions(path=[sys.argv[1]])],key=lambda p:p["name"])))', str(bundle/'site')]))
        receipt = dict(CONFIG, target=target, packages=packages,
                       compatibilitySha256={p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                            for p in sorted(compatibility.iterdir()) if p.is_file()},
                       uvVersion=subprocess.check_output([uv, '--version'], text=True).strip(),
                       analyticsLockSha256=hashlib.sha256((Path(__file__).with_name('analytics')/'uv.lock').read_bytes()).hexdigest(),
                       dependencyLockSha256=hashlib.sha256(Path(__file__).with_name('requirements.lock').read_bytes()).hexdigest())
        (bundle/'manifest.json').write_text(json.dumps(receipt, indent=2)+'\n')
        # Inventory every shipped byte. License files from wheel .dist-info and Python stay in place.
        inventory = {p.relative_to(bundle).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(bundle.rglob('*')) if p.is_file()}
        (bundle/'checksums.json').write_text(json.dumps(inventory, indent=2)+'\n')
        # Preserve the last good bundle until every preparation step succeeds.
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(bundle, destination)
    print(f'Runtime prepared: {destination}')

if __name__ == '__main__':
    main()
