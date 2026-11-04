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


class KernelBtfLayoutTests(unittest.TestCase):
    def test_running_kernel_layout_is_read_in_either_byte_order(self):
        import struct
        for endian in ('<','>'):
            with self.subTest(endian=endian),tempfile.TemporaryDirectory() as directory:
                strings=b'\0pid\0numbers\0'
                types=struct.pack(endian+'IIIIII',1,(4<<24)|1,64,5,0,128)
                header=struct.pack(endian+'HBBIIIII',0xeb9f,1,0,24,0,len(types),len(types),len(strings))
                path=Path(directory)/'btf';path.write_bytes(header+types+strings)
                self.assertEqual(trace.pid_numbers_offset(path),16)

    def test_missing_truncated_or_wrong_btf_never_invents_an_offset(self):
        for raw in (b'',b'not-btf'*8,b'\x9f\xeb'+b'\0'*22):
            with self.subTest(raw=raw),tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'btf';path.write_bytes(raw)
                with self.assertRaises(RuntimeError):trace.pid_numbers_offset(path)
