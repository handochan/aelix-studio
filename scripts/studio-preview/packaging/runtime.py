"""Audit installed, unmodified source wheels without consulting a package registry."""
import hashlib
import importlib
import importlib.metadata as metadata
import json
from pathlib import Path
import subprocess
import sys
import zipfile


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def compare_payload(wheel, site):
    root, checked = Path(site).resolve(), 0
    with zipfile.ZipFile(wheel) as archive:
        for entry in archive.infolist():
            if entry.is_dir() or entry.filename.endswith('.dist-info/RECORD'):
                continue
            dest = (root / entry.filename).resolve()
            if not dest.is_relative_to(root) or '.data' in Path(entry.filename).parts:
                raise ValueError('Unexpected wheel member layout')
            if not dest.is_file() or dest.read_bytes() != archive.read(entry):
                raise ValueError('Installed wheel member changed')
            checked += 1
    return checked


def verify(manifest, artifacts):
    results = []
    for spec in manifest['wheels']:
        wheel = Path(artifacts) / spec['filename']
        if digest(wheel) != spec['sha256'] or wheel.stat().st_size != spec['size']:
            raise ValueError('Source wheel digest/size mismatch')
        distribution = metadata.distribution(spec['distribution'])
        if distribution.version != spec['version']:
            raise ValueError('Unexpected installed native version')
        site = Path(distribution.locate_file('')).resolve()
        if not site.is_relative_to(Path(sys.prefix).resolve()) or sys.prefix == sys.base_prefix:
            raise ValueError('Run qualification in a disposable virtual environment')
        direct = json.loads(distribution.read_text('direct_url.json') or '{}')
        if any(key in direct for key in ('dir_info', 'vcs_info')):
            raise ValueError('Install source wheels, not editable checkouts')
        results.append(dict(distribution=spec['distribution'], sha256=spec['sha256'],
                            installedMembersVerified=compare_payload(wheel, site)))
    imports = []
    for name, symbol in manifest.get('imports', []):
        module = importlib.import_module(name)
        if not Path(module.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()):
            raise ValueError('Native import escaped the verified install')
        getattr(module, symbol)
        imports.append(name + ':' + symbol)
    return dict(wheels=results, imports=imports, source=manifest['sourceTag'])


def adapter_receipt(entrypoint, source):
    python = Path(entrypoint).parent / ('python.exe' if sys.platform == 'win32' else 'python')
    code = '''import hashlib,importlib.metadata as m,json,pathlib,sys
d=m.distribution('aelix-acp')
assert pathlib.Path(d.locate_file('')).resolve().is_relative_to(pathlib.Path(sys.prefix).resolve())
print(json.dumps(dict(version=d.version,packageFiles={str(p).replace('\\\\','/'):hashlib.sha256(d.locate_file(p).read_bytes()).hexdigest() for p in d.files if str(p).replace('\\\\','/').startswith('aelix_acp/') and '__pycache__' not in p.parts})))'''
    result = json.loads(subprocess.check_output([str(python), '-I', '-B', '-c', code], text=True, encoding='utf-8'))
    expected = {'aelix_acp/' + file.relative_to(source).as_posix(): digest(file)
                for file in Path(source).rglob('*') if file.is_file() and '__pycache__' not in file.parts}
    if result['packageFiles'] != expected:
        raise ValueError('Installed ACP payload differs from its exact source')
    return result
