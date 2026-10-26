"""Host source preparation refuses provenance drift and unsafe archives."""
import hashlib
import importlib.util
import io
import os
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
