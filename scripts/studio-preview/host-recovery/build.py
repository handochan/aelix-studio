"""Build a source-pinned, separately identified AionCore permission-recovery candidate.

The released host baseline and public Aelix native wheels are never modified.
Requires the upstream-pinned Rust toolchain and Git. No global install is done.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / 'source.json'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def extract(archive, destination):
    """Validate every member before writing; extract only regular source files."""
    destination = Path(destination).resolve()
    with tarfile.open(archive) as source:
        entries = []
        prefix = None
        for member in source.getmembers():
            parts = Path(member.name).parts
            if not parts or '\\' in member.name or ':' in member.name or member.issym() or member.islnk() or '..' in parts:
                raise ValueError('Unsafe source archive member')
            prefix = prefix or parts[0]
            if parts[0] != prefix:
                raise ValueError('Source archive must have one root')
            relative = Path(*parts[1:])
            target = (destination / relative).resolve()
            if not target.is_relative_to(destination):
                raise ValueError('Source archive escapes destination')
            if member.isfile():
                entries.append((member, target))
            elif not member.isdir():
                raise ValueError('Unsupported source archive entry')
        for member, target in entries:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.extractfile(member).read())
            target.chmod(member.mode & 0o777)


def verify_source(archive, source_root, config, patched):
    """Compare all original archive files, allowing only the reviewed patch."""
    if digest(archive) != config['upstream']['archiveSha256']:
        raise ValueError('Source archive digest differs from the pinned baseline')
    count = 0
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            if not member.isfile():
                continue
            relative = Path(*Path(member.name).parts[1:]).as_posix()
            expected = hashlib.sha256(source.extractfile(member).read()).hexdigest()
            patch_spec = config['patch']['files'].get(relative)
            if patch_spec:
                if expected != patch_spec['beforeSha256']:
                    raise ValueError('Patch base digest differs: ' + relative)
                if patched:
                    expected = patch_spec['afterSha256']
            if digest(Path(source_root) / relative) != expected:
                raise ValueError('Source file differs: ' + relative)
            count += 1
    return count


def apply_patch(source_root, config):
    patch = HERE / config['patch']['filename']
    if digest(patch) != config['patch']['sha256']:
        raise ValueError('Patch digest differs from the reviewed manifest')
    env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(Path(source_root).resolve().parent))
    for check in (True, False):
        subprocess.run(['git', 'apply', *(['--check'] if check else []), str(patch)],
                       cwd=source_root, env=env, check=True, capture_output=True, text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=MANIFEST)
    parser.add_argument('--target', help='Native Node-style target from the release manifest')
    parser.add_argument('--archive', type=Path, required=True, help='Exact public source archive pinned in source.json')
    parser.add_argument('--output', type=Path, required=True, help='New task-owned output directory; existing paths are refused')
    parser.add_argument('--cargo', default=shutil.which('cargo'), help='Pinned Rust Cargo executable (normal rustup proxy path)')
    parser.add_argument('--target-dir', type=Path, help='Optional task-owned Cargo cache, without changing source identity')
    args = parser.parse_args()
    manifest = args.manifest.resolve()
    config = json.loads(manifest.read_text())
    if config.get('purpose') == 'default_runtime':
        if digest(Path(__file__)) != config['buildRecipeSha256'] or digest(HERE / 'identity.py') != config['identityRecipeSha256']:
            raise ValueError('Default host build recipe differs from its source policy')
    architecture = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine().lower())
    system = {'Darwin': 'darwin', 'Linux': 'linux', 'Windows': 'win32'}.get(platform.system())
    native_target = str(system) + '-' + str(architecture)
    target_spec = None
    if 'targets' in config:
        target_spec = config['targets'].get(args.target or native_target)
        if not target_spec or (args.target and args.target != native_target):
            raise ValueError('Source host builds require a matching native runner')
    elif platform.system() + '/' + platform.machine() not in config['acceptanceTargets']:
        raise ValueError('This candidate build acceptance currently covers Darwin/arm64 only')
    resource_recipe = HERE.parents[2] / 'packages/shared-scripts/src/prepare-aioncore.js'
    resource_identity = resource_recipe.with_name('default-host.js')
    if config.get('purpose') == 'default_runtime':
        if digest(resource_recipe) != config['managedResourceRecipeSha256'] or digest(resource_identity) != config['resourceIdentityRecipeSha256']:
            raise ValueError('Managed resource recipe differs from the source policy')
    if not args.cargo:
        raise ValueError('The pinned Rust toolchain is required')
    archive, output = args.archive.resolve(), args.output.resolve()
    if digest(archive) != config['upstream']['archiveSha256']:
        raise ValueError('Source archive digest differs from the pinned baseline')
    output.mkdir(parents=True, exist_ok=False)
    source_root = output / 'source'
    report = {'schema': 'aelix-studio.host-recovery-build/1', 'status': 'failed',
              'sourcePolicySha256': hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
              'sourceManifestSha256': digest(manifest), 'buildRecipeSha256': digest(Path(__file__)), 'patchSha256': config['patch']['sha256'],
              'upstream': config['upstream'], 'profile': config['hostBuildProfile'],
              'platform': platform.system() + '/' + platform.machine(),
              'releasedHostBytes': False, 'nativePatches': [],
              'target': native_target, 'purpose': config.get('purpose', 'development_candidate'),
              'binary': 'aioncore.exe' if system == 'win32' else 'aioncore'}
    try:
        extract(archive, source_root)
        report['originalSourceFilesVerified'] = verify_source(archive, source_root, config, patched=False)
        if digest(source_root / 'Cargo.lock') != config['cargoLockSha256']:
            raise ValueError('Cargo lock differs from the pinned source')
        if digest(source_root / 'LICENSE') != config['upstreamLicenseSha256']:
            raise ValueError('Upstream license file differs')
        apply_patch(source_root, config)
        report['patchedSourceFilesVerified'] = verify_source(archive, source_root, config, patched=True)
        cargo = str(Path(args.cargo).absolute())
        report['cargoVersion'] = subprocess.check_output([cargo, '--version'], cwd=source_root, text=True).strip()
        if config['rustToolchain'] not in report['cargoVersion']:
            raise ValueError('Cargo differs from the upstream-pinned toolchain')
        report['rustcVersionVerbose'] = subprocess.check_output([str(Path(cargo).with_name('rustc.exe' if system == 'win32' else 'rustc')), '--version', '--verbose'], cwd=source_root, text=True).strip()
        if 'rustc ' + config['rustToolchain'] + ' ' not in report['rustcVersionVerbose']:
            raise ValueError('Rust compiler differs from the upstream-pinned toolchain')
        target = args.target_dir.resolve() if args.target_dir else source_root / 'target'
        argv = [cargo, 'build', '--locked', '-p', 'aionui-app', '--bin', 'aioncore', '--target-dir', str(target)]
        profile = config['hostBuildProfile']
        if profile not in ('dev', 'release'):
            raise ValueError('Unsupported host profile')
        if profile == 'release':
            argv.append('--release')
        if target_spec:
            argv.extend(['--target', target_spec['rustTarget']])
        report['buildArgv'] = argv
        with (output / 'build.log').open('w') as log:
            subprocess.run(argv, cwd=source_root, check=True, stdout=log, stderr=subprocess.STDOUT)
        binary_dir = target / target_spec['rustTarget'] if target_spec else target
        binary_dir /= 'release' if profile == 'release' else 'debug'
        shutil.copy2(binary_dir / report['binary'], output / report['binary'])
        shutil.copy2(source_root / 'LICENSE', output / 'AIONCORE-LICENSE.txt')
        report['sourceFilesAfterBuildVerified'] = verify_source(archive, source_root, config, patched=True)
        report['binarySha256'] = digest(output / report['binary'])
        identity_spec = importlib.util.spec_from_file_location('studio_host_identity', HERE / 'identity.py')
        identity = importlib.util.module_from_spec(identity_spec)
        identity_spec.loader.exec_module(identity)
        report['binaryCodeSha256'] = identity.host_identity(output / report['binary'])
        report['identityRecipeSha256'] = digest(HERE / 'identity.py')
        report['licenseFileSha256'] = digest(output / 'AIONCORE-LICENSE.txt')
        report['cargoLockSha256'] = digest(source_root / 'Cargo.lock')
        if config.get('purpose') == 'default_runtime':
            # The source build receipt seals the exported resources as well as the
            # host, before mutable packaging manifests are generated.
            resource_script = (
                "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');"
                "require(process.argv[1]).prepareManagedResources(process.argv[3],process.argv[4]);"
                "const{inventory,stable}=require(process.argv[2]);"
                "const entries=inventory(path.join(process.argv[4],'managed-resources'),{excludeManifest:false});"
                "fs.writeFileSync(path.join(process.argv[4],'resource-identity.json'),JSON.stringify({"
                "sha256:crypto.createHash('sha256').update(stable(entries)).digest('hex'),entries}));")
            subprocess.run(['node', '-e', resource_script, str(resource_recipe), str(resource_identity),
                            str(output / report['binary']), str(output)], check=True)
            resources = json.loads((output / 'resource-identity.json').read_text())
            report['managedResourcesSha256'] = resources['sha256']
            report['managedResourceRecipeSha256'] = digest(resource_recipe)
            report['resourceIdentityRecipeSha256'] = digest(resource_identity)
        report['status'] = 'built_candidate'
    finally:
        (output / 'build-receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'binarySha256': report['binarySha256'], 'output': str(output)}))


if __name__ == '__main__':
    main()
