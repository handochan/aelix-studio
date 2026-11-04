"""Tracepoint preflight requires complete kernel event schemas, never empty success."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'scripts/studio-preview/fixtures/uringTrace.py'
spec=importlib.util.spec_from_file_location('uring_trace_probe',SOURCE)
trace=importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)


class TracepointFormatTests(unittest.TestCase):
    def make(self,root,submit='io_uring_submit_req'):
        for name,fields in [('io_uring_create',trace.CREATE_FIELDS),(submit,trace.SUBMIT_FIELDS)]:
            path=root/'events/io_uring'/name/'format';path.parent.mkdir(parents=True)
            path.write_text('\n'.join('field:unsigned long '+field+'; offset:0; size:8;' for field in fields))
        return root/'events/io_uring'/submit/'format'

    def test_new_and_old_submission_names_are_supported(self):
        for event in ('io_uring_submit_req','io_uring_submit_sqe'):
            with self.subTest(event=event),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);self.make(root,event)
                name,formats=trace.event_formats(root)
                self.assertEqual(name,event)
                self.assertEqual(len(formats),2)

    def test_absent_events_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError,'missing'):
                trace.event_formats(Path(directory))

    def test_incomplete_opcode_or_sq_thread_schema_fails_closed(self):
        for field in ('opcode','sq_thread'):
            with self.subTest(field=field),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);path=self.make(root)
                path.write_text(path.read_text().replace(field,'unavailable'))
                with self.assertRaisesRegex(RuntimeError,'fields_missing'):
                    trace.event_formats(root)

    def test_create_requires_correlatable_ctx_and_fd(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.make(root)
            path=root/'events/io_uring/io_uring_create/format'
            path.write_text(path.read_text().replace('ctx','unavailable'))
            with self.assertRaisesRegex(RuntimeError,'fields_missing'):
                trace.event_formats(root)
