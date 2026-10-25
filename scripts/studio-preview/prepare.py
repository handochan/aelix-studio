"""Prepare an isolated public-wheel/ACP/AionCore baseline, not a release bundle."""
import hashlib
import argparse
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name('baseline.json')
OUTPUT = ROOT / '.local/studio-preview'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def host_target(system=None, machine=None):
    """Return the declared Node-style platform/architecture target."""
    system, machine = system or sys.platform, (machine or platform.machine()).lower()
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(machine)
    if system not in ('darwin', 'linux', 'win32') or arch is None:
        raise ValueError('Unsupported host platform')
    return system + '-' + arch


def venv_path(runtime, name, executable='python'):
    directory = 'Scripts' if sys.platform == 'win32' else 'bin'
    return runtime / name / directory / (executable + '.exe' if sys.platform == 'win32' else executable)


def managed_python(directory, system=None):
    """Choose one owned standalone installation, never a system Python or minor alias."""
    candidates = [entry for entry in directory.iterdir()
                  if entry.name.startswith('cpython-') and entry.is_dir() and not entry.is_symlink()
                  and not (hasattr(entry, 'is_junction') and entry.is_junction())]
    if len(candidates) != 1:
        raise ValueError('Expected one owned standalone Python installation')
    executable = candidates[0] / ('python.exe' if (system or sys.platform) == 'win32' else 'bin/python3')
    if not executable.is_file() or not executable.resolve().is_relative_to(directory.resolve()):
        raise ValueError('Standalone Python executable escapes its owned installation')
    return executable


def download(url, destination, expected):
    if not destination.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            destination.write_bytes(response.read())
    if digest(destination) != expected:
        raise ValueError('Checksum mismatch: ' + destination.name)


def extract(archive, destination):
    """Extract regular files only; reject traversal and links before writing."""
    destination = destination.resolve()
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                target = (destination / member.filename).resolve()
                # ZipInfo normalizes host separators on Windows. Inspect the
                # original archive spelling before trusting its normalized path.
                if '\\' in member.orig_filename or ':' in member.orig_filename or not target.is_relative_to(destination) or (member.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Unsafe archive member')
            for member in source.infolist():
                if not member.is_dir():
                    target = destination / member.filename
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read(member))
        return
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            target = (destination / member.name).resolve()
            if '\\' in member.name or ':' in member.name or not target.is_relative_to(destination) or member.issym() or member.islnk():
                raise ValueError('Unsafe archive member')
        for member in source.getmembers():
            if member.isfile():
                target = destination / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.extractfile(member).read())
                target.chmod(member.mode & 0o777)


def verify_prepared(runtime, baseline=MANIFEST):
    """Fail before host startup when the selected host, launcher or baseline drifts."""
    receipt = json.loads((runtime / 'receipt.json').read_text())
    if receipt['baselineSha256'] != digest(baseline):
        raise ValueError('Prepared runtime has a different baseline')
    if receipt.get('dependencyLockSha256') and receipt['dependencyLockSha256'] != digest(Path(__file__).parent / 'packaging/native-requirements.lock'):
        raise ValueError('Prepared runtime has a different dependency lock')
    if receipt['launcherSha256'] != digest(Path(__file__).with_name('launch.cjs')):
        raise ValueError('Prepared runtime has a stale launcher')
    for relative, key in ((receipt['aioncoreBinary'], 'aioncoreBinarySha256'), ('launch.cjs', 'launcherSha256'),
                          ('qualification.json', 'qualificationSha256')):
        target = (runtime / relative).resolve()
        if not target.is_relative_to(runtime.resolve()) or digest(target) != receipt[key]:
            raise ValueError('Prepared host/launcher bytes changed')
    for relative, expected in receipt['entrypointSha256'].items():
        if digest(runtime / relative) != expected:
            raise ValueError('Prepared entrypoint bytes changed')
    return receipt


def main(output=OUTPUT, expected_target=None):
    config = json.loads(MANIFEST.read_text())
    if json.loads((ROOT / 'package.json').read_text())['aioncoreVersion'] != config['aioncore']['tag']:
        raise ValueError('Studio AionCore pin differs from the qualified pairing')
    target = host_target()
    if expected_target and expected_target != target:
        raise ValueError('Runner does not match the requested target')
    if target not in config['aioncore']['assets']:
        raise ValueError('Host target has no qualified AionCore asset')
    # Never replace an existing environment or an operator's runtime.
    output.mkdir(parents=True, exist_ok=False)
    env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP') if key in os.environ}
    env.update(UV_NO_CONFIG='1', UV_DEFAULT_INDEX='https://pypi.org/simple', UV_LINK_MODE='copy', PYTHONDONTWRITEBYTECODE='1')

    def run(*args, capture=False):
        return subprocess.run(list(map(str, args)), check=True, env=env, cwd=output,
                              text=True, stdout=subprocess.PIPE if capture else None).stdout

    acp = config['acp']
    archive = output / 'acp.tar.gz'
    download(f"https://codeload.github.com/{acp['repository']}/tar.gz/{acp['commit']}", archive, acp['archiveSha256'])
    extract(archive, output / 'source')
    source = output / 'source' / ('aelix-acp-' + acp['commit'])
    if json.loads((source / 'docs/beta2/manifest.json').read_text()) != config['native']:
        raise ValueError('Studio native baseline differs from accepted ACP qualification')
    uv = shutil.which('uv')
    if not uv:
        raise ValueError('Build prerequisite missing: uv')
    python_root = output / 'python-base'
    run(uv, '--no-config', 'python', 'install', config['python'], '--no-bin', '--no-registry', '--install-dir', python_root)
    python = managed_python(python_root)
    for name in ('native', 'adapter'):
        run(uv, '--no-config', 'venv', '--python', python, '--no-project', output / name)
    native = venv_path(output, 'native')
    adapter = venv_path(output, 'adapter')
    wheels = output / 'wheels'
    wheels.mkdir()
    for spec in config['native']['wheels']:
        download(spec['url'], wheels / spec['filename'], spec['sha256'])
    dependency_lock = Path(__file__).parent / 'packaging/native-requirements.lock'
    run(uv, '--no-config', 'pip', 'sync', '--python', native, '--index-url', 'https://pypi.org/simple',
        '--require-hashes', '--only-binary', ':all:', dependency_lock)
    for bootstrap in config.get('platformBootstrap', {}).get(target, []):
        download(bootstrap['url'], wheels / bootstrap['filename'], bootstrap['sha256'])
    run(uv, '--no-config', 'build', '--wheel', '--python', native, '--out-dir', output / 'acp-wheel', source)
    wheel, = (output / 'acp-wheel').glob('*.whl')
    run(uv, '--no-config', 'pip', 'install', '--python', adapter, '--no-index', wheel)
    run(native, '-B', source / 'scripts/qualify_beta2.py', '--adapter', venv_path(output, 'adapter', 'aelix-acp'),
        '--artifacts', wheels, '--report', output / 'qualification.json')
    core = config['aioncore']
    asset = core['assets'][target]
    archive = output / asset['filename']
    download(f"https://github.com/{core['repository']}/releases/download/{core['tag']}/{asset['filename']}", archive, asset['sha256'])
    extract(archive, output / 'aioncore')
    binary, = (output / 'aioncore').rglob('aioncore.exe' if sys.platform == 'win32' else 'aioncore')
    shutil.copy(Path(__file__).with_name('launch.cjs'), output / 'launch.cjs')
    receipt = dict(config, target=target, baselineSha256=digest(MANIFEST), acpWheelSha256=digest(wheel),
                   aioncoreBinary=str(binary.relative_to(output)), aioncoreBinarySha256=digest(binary),
                   launcherSha256=digest(output / 'launch.cjs'),
                   qualificationSha256=digest(output / 'qualification.json'),
                   entrypointSha256={path.relative_to(output).as_posix(): digest(path) for path in (venv_path(output, 'native', 'aelix'), venv_path(output, 'adapter', 'aelix-acp'))},
                   dependencyLockSha256=digest(dependency_lock),
                   uvVersion=run(uv, '--version', capture=True).strip(), pythonProvider='uv-managed-standalone')
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Prepared isolated baseline: ' + str(output))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--target')
    args = parser.parse_args()
    main(args.output.resolve(), args.target)
