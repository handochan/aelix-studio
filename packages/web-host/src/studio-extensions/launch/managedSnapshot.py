"""Studio's managed extension launch input and candidate verification."""
import json
import os
from pathlib import Path
import re
import runpy
import sys
import tomllib

_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}')
_MODULE = re.compile(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*', re.ASCII)
_PACK = re.compile(r'pack-inputs/[0-9]{1,8}')
_MAX_INPUT = 1024 * 1024


def valid_id(value):
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def module_reference(value):
    return (isinstance(value, str) and _MODULE.fullmatch(value) is not None
            and (os.name != 'nt' or value[1] != ':' or not value[0].isalpha()))


def validate_catalogue(catalogue):
    """Check generation-local metadata before accepting a current or fallback pointer."""
    if not isinstance(catalogue, list):
        raise ValueError('invalid managed catalogue')
    ids = set()
    for item in catalogue:
        common = {'id', 'reference'}
        if not isinstance(item, dict) or set(item) not in (common, common | {'entryPoints'}):
            raise ValueError('invalid managed catalogue entry')
        identifier, reference = item['id'], item['reference']
        if not valid_id(identifier) or identifier in ids:
            raise ValueError('invalid or duplicate managed extension ID')
        ids.add(identifier)
        if 'entryPoints' in item:
            points = item['entryPoints']
            if (not isinstance(reference, str) or not _PACK.fullmatch(reference)
                    or not isinstance(points, list) or not points or not all(map(module_reference, points))
                    or len(set(points)) != len(points)):
                raise ValueError('invalid managed pack input or entry points')
        elif not module_reference(reference):
            raise ValueError('invalid managed module reference')


def snapshot(generation, site, catalogue, defaults):
    validate_catalogue(catalogue)
    if not valid_id(generation):
        raise ValueError('invalid generation ID')
    if not isinstance(defaults, dict) or any(not valid_id(key) or type(value) is not bool
                                             for key, value in defaults.items()):
        raise ValueError('invalid managed defaults')
    site = Path(site).resolve(strict=True)
    if not site.is_dir():
        raise ValueError('invalid generation site-packages')
    # Site paths are venv/lib/pythonX.Y/site-packages or venv/Lib/site-packages.
    directory = site.parents[2 if os.name == 'nt' else 3]
    if directory.name != generation:
        raise ValueError('site-packages belongs to another generation')
    installed, aliases, wrappers = [], set(), set()
    for item in catalogue:
        identifier, reference = item['id'], item['reference']
        entry = {'id': identifier, 'reference': reference, 'defaultEnabled': defaults.get(identifier, True)}
        if 'entryPoints' in item:
            points = item['entryPoints']
            wrapper = directory.joinpath(*reference.split('/'))
            if wrapper.resolve(strict=True) != wrapper or wrapper in wrappers:
                raise ValueError('managed pack wrapper is linked or duplicated')
            wrappers.add(wrapper)
            children = list(wrapper.iterdir())
            if len(children) != 1 or not children[0].is_dir():
                raise ValueError('managed pack wrapper must contain one package directory')
            package = children[0].resolve(strict=True)
            if package == site or not package.is_relative_to(site):
                raise ValueError('managed pack resolves outside generation site-packages')
            manifest = (package / 'aelix-plugin.toml').resolve(strict=True)
            if not manifest.is_relative_to(package):
                raise ValueError('managed pack manifest resolves outside its package')
            metadata = tomllib.loads(manifest.read_text(encoding='utf-8')).get('plugin')
            plugin = metadata.get('id') if isinstance(metadata, dict) else None
            if not valid_id(plugin):
                raise ValueError('invalid managed pack plugin ID')
            factory = metadata.get('entry')
            factory = factory.get('python') if isinstance(factory, dict) else None
            entry_aliases = {plugin, *points}
            if module_reference(factory):
                entry_aliases.add(factory)
            entry['reference'] = str(wrapper)
            entry['entryPoints'] = points
        else:
            entry_aliases = {reference}
        if aliases.intersection(entry_aliases):
            raise ValueError('overlapping managed extension keys or load references')
        aliases.update(entry_aliases)
        installed.append(entry)
    result = {'version': 1, 'generation': generation, 'extensions': installed}
    if any('entryPoints' not in item for item in installed):
        result['sitePackages'] = str(site)
    return result


def encode(value):
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(raw) > _MAX_INPUT:
        raise ValueError('managed snapshot exceeds 1 MiB')
    return raw


def verify(bundle, site, request):
    # Use false, which takes one more byte than true, to bound later default changes.
    catalogue = request['catalogue']
    value = snapshot(request['generation'], site, catalogue, {item['id']: False for item in catalogue})
    encode(value)
    if 'sitePackages' not in value:
        return
    verifier = bundle / 'adapter-site/aelix_acp/runtime/managed_module.py'
    if not verifier.is_file():
        verifier = bundle / 'managed-verifier/managed_module.py'
    load_factory = runpy.run_path(str(verifier))['load_factory']
    entries = value['extensions']
    packages = tuple(sorted({
        point.split(':', 1)[0].split('.', 1)[0]
        for entry in entries for point in entry.get('entryPoints', [entry['reference']])
    }))
    sys.path.append(value['sitePackages'])
    for entry in entries:
        if 'entryPoints' not in entry:
            try:
                load_factory(value['sitePackages'], entry['reference'], packages)
            except Exception as error:
                raise ValueError(f"{entry['id']}: managed factory origin could not be verified") from error
