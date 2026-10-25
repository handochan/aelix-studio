"""Prepare an isolated public-wheel/ACP/AionCore baseline, not a release bundle."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name('baseline.json')
OUTPUT = ROOT / '.local/studio-preview'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def download(url, destination, expected):
    if not destination.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            destination.write_bytes(response.read())
    if digest(destination) != expected:
        raise ValueError('Checksum mismatch: ' + destination.name)


def extract(archive, destination):
    """Extract regular files only; reject traversal and links before writing."""
    destination = destination.resolve()
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            target = (destination / member.name).resolve()
            if not target.is_relative_to(destination) or member.issym() or member.islnk():
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
    for relative, key in ((receipt['aioncoreBinary'], 'aioncoreBinarySha256'), ('launch.cjs', 'launcherSha256'),
                          ('qualification.json', 'qualificationSha256')):
        target = (runtime / relative).resolve()
        if not target.is_relative_to(runtime.resolve()) or digest(target) != receipt[key]:
            raise ValueError('Prepared host/launcher bytes changed')
    for relative, expected in receipt['entrypointSha256'].items():
        if digest(runtime / relative) != expected:
            raise ValueError('Prepared entrypoint bytes changed')
    return receipt


def main():
    config = json.loads(MANIFEST.read_text())
    if json.loads((ROOT / 'package.json').read_text())['aioncoreVersion'] != config['aioncore']['tag']:
        raise ValueError('Studio AionCore pin differs from the qualified pairing')
    if sys.platform != 'darwin':
        raise ValueError('This qualification harness currently pins darwin-arm64 only')
    target = sys.platform + '-' + {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64'}.get(os.uname().machine, 'unknown')
    if target not in config['aioncore']['assets']:
        raise ValueError('This qualification harness currently pins darwin-arm64 only')
    # Never replace an existing environment or an operator's runtime.
    OUTPUT.mkdir(parents=True, exist_ok=False)
    env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'TMP', 'TEMP') if key in os.environ}
    env.update(UV_NO_CONFIG='1', UV_DEFAULT_INDEX='https://pypi.org/simple', UV_LINK_MODE='copy', PYTHONDONTWRITEBYTECODE='1')

    def run(*args, capture=False):
        return subprocess.run(list(map(str, args)), check=True, env=env, cwd=OUTPUT,
                              text=True, stdout=subprocess.PIPE if capture else None).stdout

    acp = config['acp']
    archive = OUTPUT / 'acp.tar.gz'
    download(f"https://codeload.github.com/{acp['repository']}/tar.gz/{acp['commit']}", archive, acp['archiveSha256'])
    extract(archive, OUTPUT / 'source')
    source = OUTPUT / 'source' / ('aelix-acp-' + acp['commit'])
    if json.loads((source / 'docs/beta2/manifest.json').read_text()) != config['native']:
        raise ValueError('Studio native baseline differs from accepted ACP qualification')
    uv = shutil.which('uv')
    if not uv:
        raise ValueError('Build prerequisite missing: uv')
    for name in ('native', 'adapter'):
        run(uv, '--no-config', 'venv', '--python', config['python'], '--no-project', OUTPUT / name)
    native = OUTPUT / 'native/bin/python'
    adapter = OUTPUT / 'adapter/bin/python'
    wheels = OUTPUT / 'wheels'
    wheels.mkdir()
    for spec in config['native']['wheels']:
        download(spec['url'], wheels / spec['filename'], spec['sha256'])
    run(uv, '--no-config', 'pip', 'install', '--python', native, '--index-url', 'https://pypi.org/simple',
        '--only-binary', ':all:', *sorted(wheels.glob('*.whl')))
    run(uv, '--no-config', 'build', '--wheel', '--python', native, '--out-dir', OUTPUT / 'acp-wheel', source)
    wheel, = (OUTPUT / 'acp-wheel').glob('*.whl')
    run(uv, '--no-config', 'pip', 'install', '--python', adapter, '--no-index', wheel)
    run(native, '-B', source / 'scripts/qualify_beta2.py', '--adapter', OUTPUT / 'adapter/bin/aelix-acp',
        '--artifacts', wheels, '--report', OUTPUT / 'qualification.json')
    core = config['aioncore']
    asset = core['assets'][target]
    archive = OUTPUT / asset['filename']
    download(f"https://github.com/{core['repository']}/releases/download/{core['tag']}/{asset['filename']}", archive, asset['sha256'])
    extract(archive, OUTPUT / 'aioncore')
    binary, = (OUTPUT / 'aioncore').rglob('aioncore')
    shutil.copy(Path(__file__).with_name('launch.cjs'), OUTPUT / 'launch.cjs')
    receipt = dict(config, target=target, baselineSha256=digest(MANIFEST), acpWheelSha256=digest(wheel),
                   aioncoreBinary=str(binary.relative_to(OUTPUT)), aioncoreBinarySha256=digest(binary),
                   launcherSha256=digest(OUTPUT / 'launch.cjs'),
                   qualificationSha256=digest(OUTPUT / 'qualification.json'),
                   entrypointSha256={name: digest(OUTPUT / name) for name in ('native/bin/aelix', 'adapter/bin/aelix-acp')},
                   uvVersion=run(uv, '--version', capture=True).strip())
    (OUTPUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Prepared isolated baseline: ' + str(OUTPUT))


if __name__ == '__main__':
    main()
