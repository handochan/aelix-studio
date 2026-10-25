"""Build a relocatable macOS arm64 payload from the accepted public-wheel baseline.

No native/ACP files are patched. This is a build-time operation, never a runtime download.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('preview_prepare', Path(__file__).parents[1] / 'prepare.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def copy_tree(source, destination):
    for file in source.rglob('*'):
        if file.is_symlink() and (Path(os.readlink(file)).is_absolute() or not file.resolve().is_relative_to(source.resolve())):
            raise ValueError('Runtime symlink escapes its owned tree')
    shutil.copytree(source, destination, symlinks=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '_virtualenv.py', '_virtualenv.pth'))


def main(args):
    runtime = Path(args.runtime).resolve()
    receipt = prepare.verify_prepared(runtime)
    if receipt['target'] != 'darwin-arm64' or sys.platform != 'darwin':
        raise ValueError('This installer payload is qualified only for macOS arm64')
    destination = Path(args.output).resolve()
    if destination.exists():
        raise ValueError('Refusing to replace an existing bundle')
    destination.parent.mkdir(parents=True, exist_ok=True)
    def metadata(kind):
        result = subprocess.check_output([str(runtime / kind / 'bin/python'), '-I', '-B', '-c',
            'import sys,sysconfig,json;print(json.dumps(dict(base=sys.base_prefix,site=sysconfig.get_paths()["purelib"],version=sys.version.split()[0])))'], text=True)
        return json.loads(result)
    native, adapter = metadata('native'), metadata('adapter')
    if native['base'] != adapter['base']:
        raise ValueError('Native and ACP Python bases differ')
    # Original pure-Python wheel members must still match the public artifacts.
    qualifier = runtime / 'source' / ('aelix-acp-' + receipt['acp']['commit']) / 'scripts'
    qualification = json.loads((runtime / 'qualification.json').read_text())
    for name, expected in qualification['harnessSourceSha256'].items():
        if digest(qualifier / name) != expected:
            raise ValueError('Accepted qualification harness changed')
    observed_adapter = subprocess.check_output([str(runtime / 'native/bin/python'), '-I', '-B', '-c',
        'import sys,json;sys.path.insert(0,sys.argv[1]);from qualify_beta2 import adapter_receipt;from pathlib import Path;print(json.dumps(adapter_receipt(Path(sys.argv[2]))))',
        str(qualifier), str(runtime / 'adapter/bin/aelix-acp')], text=True)
    if json.loads(observed_adapter) != qualification['installedAdapter']:
        raise ValueError('Installed ACP differs from its accepted qualification/source')
    base_site = Path(native['base']) / 'lib' / ('python' + '.'.join(native['version'].split('.')[:2])) / 'site-packages'
    if any(base_site.glob('*.pth')) or any(base_site.glob('*.egg-link')):
        raise ValueError('Standalone Python base contains site injection files')
    for entry in base_site.iterdir() if base_site.exists() else []:
        if entry.name not in ('README.txt', 'pip', '__pycache__') and not entry.name.startswith('pip-'):
            raise ValueError('Standalone Python base contains unqualified user packages')
    audit = subprocess.check_output([str(runtime / 'native/bin/python'), '-I', '-B', '-c',
        'import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from beta2_identity import verify;print(json.dumps(verify(json.loads(Path(sys.argv[2]).read_text())["native"],Path(sys.argv[3]))))',
        str(qualifier), str(Path(__file__).parents[1] / 'baseline.json'), str(runtime / 'wheels')], text=True)
    with tempfile.TemporaryDirectory(prefix='studio-bundle-', dir=destination.parent) as temporary:
        bundle = Path(temporary) / 'runtime'
        bundle.mkdir()
        copy_tree(Path(native['base']), bundle / 'python')
        for kind, info in (('native', native), ('adapter', adapter)):
            site = Path(info['site'])
            # A path injection file may couple the payload to source/user packages.
            if any(file.name != '_virtualenv.pth' for file in site.glob('*.pth')) or any(site.glob('*.egg-link')):
                raise ValueError('Qualification site contains path injection files')
            copy_tree(site, bundle / (kind + '-site'))
        shutil.copy2(Path(__file__).with_name('launch.py'), bundle / 'launch.py')
        for relative, mode in (('native/bin/python', 'helper'), ('native/bin/aelix', 'native'), ('adapter/bin/aelix-acp', 'acp')):
            file = bundle / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)\n'
                            'exec "$root/python/bin/python3" -I -S -B "$root/launch.py" ' + mode + ' "$@"\n')
            file.chmod(0o755)
        manifest = dict(schema='aelix.studio-preview.runtime/1', target=receipt['target'], python=native['version'],
                        baselineSha256=receipt['baselineSha256'], native=receipt['native'], acp=receipt['acp'],
                        acpWheelSha256=receipt['acpWheelSha256'], installedAdapterAudit='matches accepted qualification', nativeWheelAudit=json.loads(audit), nativePatches=[],
                        preparedReceiptSha256=digest(runtime / 'receipt.json'),
                        recipeSha256={file.name: digest(file) for file in (Path(__file__), Path(__file__).with_name('launch.py'), Path(__file__).with_name('build.mjs'))},
                        pythonProvenance='uv-managed python-build-standalone copied from qualified CPython base; no venv',
                        entrypoints=['native/bin/python', 'native/bin/aelix', 'adapter/bin/aelix-acp'])
        (bundle / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        checksums = {str(file.relative_to(bundle)): ('symlink:' + os.readlink(file) if file.is_symlink() else digest(file))
                     for file in sorted(bundle.rglob('*')) if file.is_file() or file.is_symlink()}
        (bundle / 'checksums.json').write_text(json.dumps(checksums, indent=2) + '\n')
        shutil.move(bundle, destination)
    print('Prepared relocatable Preview runtime:', destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--output', default=str(ROOT / 'resources/studio-preview'))
    main(parser.parse_args())
