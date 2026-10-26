"""Host source preparation refuses provenance drift and unsafe archives."""
import hashlib
import importlib.util
import io
import os
import subprocess
from unittest.mock import patch
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / 'scripts/studio-preview/host-recovery/build.py'
SPEC = importlib.util.spec_from_file_location('host_recovery_build', PATH)
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class HostRecoveryBuildTests(unittest.TestCase):
    def source_fixture(self, root, files):
        archive = root / 'source.tar'
        with tarfile.open(archive, 'w') as out:
            for name, data in files.items():
                member = tarfile.TarInfo('repo/' + name)
                member.size = len(data)
                out.addfile(member, io.BytesIO(data))
        config = {'upstream': {'archiveSha256': build.digest(archive)},
                  'patch': {'files': {}}, 'sourceFileCount': len(files)}
        build.extract(archive, root / 'source')
        return archive, config

    def test_an_undeclared_build_script_is_refused_without_echoing_its_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, config = self.source_fixture(root, {'source.rs': b'original'})
            sentinel = 'SYNTHETIC_PRIVATE_BUILD_SCRIPT.rs'
            (root / 'source' / sentinel).write_bytes(b'undeclared')
            with self.assertRaisesRegex(ValueError, 'Source inventory differs') as caught:
                build.verify_source(archive, root / 'source', config, patched=False)
            self.assertNotIn(sentinel, str(caught.exception))

    def test_declared_additions_have_separate_patched_counts_and_hash_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, config = self.source_fixture(root, {'source.rs': b'original'})
            config['patch']['files']['added.rs'] = {'beforeSha256': None,
                                                   'afterSha256': hashlib.sha256(b'added').hexdigest()}
            config['patchedSourceFileCount'] = 2
            self.assertEqual(build.verify_source(archive, root / 'source', config, patched=False), 1)
            (root / 'source/added.rs').write_bytes(b'added')
            self.assertEqual(build.verify_source(archive, root / 'source', config, patched=True), 2)
            (root / 'source/added.rs').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'Source file differs'):
                build.verify_source(archive, root / 'source', config, patched=True)

    def test_a_declared_deletion_does_not_hide_an_undeclared_source_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, config = self.source_fixture(root, {'kept.rs': b'kept', 'removed.rs': b'old'})
            config['patch']['files']['removed.rs'] = {'beforeSha256': hashlib.sha256(b'old').hexdigest(),
                                                     'afterSha256': None}
            config['patchedSourceFileCount'] = 1
            (root / 'source/removed.rs').unlink()
            self.assertEqual(build.verify_source(archive, root / 'source', config, patched=True), 1)
            (root / 'source/unexpected.rs').write_bytes(b'extra')
            with self.assertRaisesRegex(ValueError, 'Source inventory differs'):
                build.verify_source(archive, root / 'source', config, patched=True)

    def test_archive_escape_is_refused_before_any_source_is_written(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'source.tar'
            with tarfile.open(archive, 'w') as out:
                for name in ('repo/safe.rs', 'repo/../../escaped.rs'):
                    member = tarfile.TarInfo(name)
                    member.size = 4
                    out.addfile(member, io.BytesIO(b'test'))
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                build.extract(archive, root / 'source')
            self.assertFalse((root / 'source/safe.rs').exists())

    def test_modified_source_member_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'source.tar'
            with tarfile.open(archive, 'w') as out:
                member = tarfile.TarInfo('repo/source.rs')
                member.size = 4
                out.addfile(member, io.BytesIO(b'test'))
            config = {'upstream': {'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}, 'patch': {'files': {}}}
            build.extract(archive, root / 'source')
            self.assertEqual(build.verify_source(archive, root / 'source', config, patched=False), 1)
            (root / 'source/source.rs').write_text('changed')
            with self.assertRaisesRegex(ValueError, 'Source file differs'):
                build.verify_source(archive, root / 'source', config, patched=False)

    def test_patch_digest_is_checked_before_git_runs(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, 'Patch digest'):
                build.apply_patch(Path(temporary), {'patch': {'filename': 'permission-restore.patch', 'sha256': '0' * 64}})


    def test_patch_keeps_pinned_lf_bytes_under_windows_style_git_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            (source / 'test.rs').write_bytes(b'old\n')
            diff = root / 'test.patch'
            diff.write_bytes(b'diff --git a/test.rs b/test.rs\n--- a/test.rs\n+++ b/test.rs\n@@ -1 +1 @@\n-old\n+new\n')
            config = {'patch': {'filename': diff.name, 'sha256': build.digest(diff)}}
            with patch.object(build, 'HERE', root), patch.dict(os.environ, {
                    'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.autocrlf', 'GIT_CONFIG_VALUE_0': 'true'}):
                build.apply_patch(source, config)
            self.assertEqual((source / 'test.rs').read_bytes(), b'new\n')


    def test_gui_keeps_display_transport_without_importing_provider_secrets_or_user_roots(self):
        spec = importlib.util.spec_from_file_location('host_recovery_smoke', PATH.with_name('smoke.py'))
        smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(smoke)
        isolated = {'HOME': 'owned-home', 'PATH': 'owned-path'}
        driver = {'DISPLAY': ':91', 'XAUTHORITY': '/owned-xvfb/auth', 'API_KEY': 'synthetic-secret', 'HOME': 'operator-home'}
        self.assertEqual(smoke.gui_environment(isolated, driver),
                         dict(isolated, DISPLAY=':91', XAUTHORITY='/owned-xvfb/auth'))


    def test_glibc_gate_rejects_a_newer_abi_than_the_retained_release_baseline(self):
        with self.assertRaisesRegex(ValueError, 'GLIBC requirement exceeds'):
            build.maximum_glibc_requirement('Name: GLIBC_2.2.5\nName: GLIBC_2.39', '2.34')
        self.assertEqual(build.maximum_glibc_requirement('Name: GLIBC_2.9\nName: GLIBC_2.30', '2.30'), '2.30')
        with self.assertRaisesRegex(ValueError, 'no auditable GLIBC'):
            build.maximum_glibc_requirement('no version table', '2.30')


class InstalledPythonAliasTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('host_recovery_alias', PATH.with_name('smoke.py'))
        self.smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.smoke)

    def test_alias_matches_the_actual_installed_file_across_windows_namespace_prefix(self):
        with tempfile.TemporaryDirectory(prefix='studio-alias-') as temporary:
            root = Path(temporary).resolve()
            installed = root / 'installed-python'
            installed.mkdir()
            (installed / 'python').write_bytes(b'owned fixture')
            target = Path('\\\\?\\' + str(installed)) if os.name == 'nt' else installed
            alias = root / 'alias'
            if os.name == 'nt':
                subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(alias), str(target)],
                               check=True, capture_output=True)
            else:
                alias.symlink_to(target, target_is_directory=True)
            self.smoke.validate_installed_python_alias(alias / 'python', target / 'python')
            if os.name == 'nt':
                alias.rmdir()

    def test_identical_bytes_in_another_runtime_are_refused(self):
        with tempfile.TemporaryDirectory(prefix='studio-alias-') as temporary:
            root = Path(temporary)
            installed, substitute = root / 'installed', root / 'substitute'
            installed.write_bytes(b'same fixture')
            substitute.write_bytes(installed.read_bytes())
            with self.assertRaisesRegex(ValueError, 'owned whitespace-free alias'):
                self.smoke.validate_installed_python_alias(substitute, installed)

    def test_whitespace_alias_is_refused_even_for_the_same_installed_file(self):
        with tempfile.TemporaryDirectory(prefix='studio-alias-') as temporary:
            root = Path(temporary)
            installed, alias = root / 'installed', root / 'alias space'
            installed.write_bytes(b'owned fixture')
            os.link(installed, alias)
            with self.assertRaisesRegex(ValueError, 'owned whitespace-free alias'):
                self.smoke.validate_installed_python_alias(alias, installed)
