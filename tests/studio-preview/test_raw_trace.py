"""Raw TP prototypes and values must match the actual kernel ABI exactly."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('raw_audit',ROOT/'scripts/studio-preview/fixtures/outboundAudit.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
from uring.rawTrace import SHAPES,validate,convert,check_coverage,coverage
from uring.entry import btf_signature
from uring.program import program
from uring.socketProgram import definitions


class RawPrototypeTests(unittest.TestCase):
    def shapes(self,new=True):
        return {name:{'parameters':list(shapes[-1 if new else 0]),'return':'void'} for name,shapes in SHAPES.items()}

    def test_known_68_and_70_prototypes_preserve_their_own_completion_abi(self):
        for new in (False,True):self.assertEqual(validate(self.shapes(new),'io_uring_submit_req'),self.shapes(new))

    def test_missing_unknown_and_reordered_arguments_fail_instead_of_guessing(self):
        for mode in ('missing','swapped','return','old_submit'):
            shapes=self.shapes();submit='io_uring_submit_req'
            if mode=='missing':shapes.pop('sys_exit')
            elif mode=='swapped':shapes['io_uring_create']['parameters'][:2]=['ptr:void','s32']
            elif mode=='return':shapes['sys_exit']['return']='s64'
            else:submit='io_uring_submit_sqe'
            with self.assertRaises(RuntimeError):validate(shapes,submit)

    def source(self,architecture):
        entry={'symbol':'syscall_trace_enter'} if architecture=='aarch64' else {
            'symbol':'ptrace_notify','threadBytes':16384,'paddingBytes':0,'pageBytes':4096}
        with patch('platform.machine',return_value=architecture):
            return program(123,42,16,'io_uring_submit_req',entry,760,definitions())

    def test_all_active_recorders_use_raw_or_per_program_trampolines(self):
        for arch in ('aarch64','x86_64'):
            source=self.source(arch)
            self.assertEqual(check_coverage(source),{'tracing':34,'raw':9,'interval':1})
            self.assertNotRegex(source,r'(?m)^(?:kprobe|kretprobe|tracepoint):')

    def test_raw_exit_uses_kernel_register_nr_and_arg1_only_as_return(self):
        for arch,number,fd in [('aarch64','syscallno','orig_x0'),('x86_64','orig_ax','di')]:
            source=self.source(arch);exit_block=source.split('rawtracepoint:sys_exit',1)[1].split('kfunc:',1)[0]
            self.assertIn('((struct pt_regs*)arg0)->'+number,exit_block)
            self.assertIn('(int64)arg1',exit_block)
            self.assertIn('((struct pt_regs*)arg0)->'+fd,source)
        self.assertIn('args->exit_code',self.source('x86_64'))
        self.assertIn('args->message',self.source('x86_64'))

    def test_failed_opcode_comes_from_sqe_and_completion_does_not_read_dead_req(self):
        source=self.source('aarch64')
        self.assertIn('((struct io_uring_sqe*)arg0)->opcode',source)
        complete=source.split('rawtracepoint:io_uring_complete',1)[1].split('interval:',1)[0]
        self.assertNotIn('io_kiocb',complete)
        self.assertIn('(uint64)(arg1)',complete)

    def test_missing_or_classic_provider_cannot_satisfy_coverage(self):
        source=self.source('aarch64')
        for bad in (source.replace('rawtracepoint:sys_exit','tracepoint:raw_syscalls:sys_exit'),
                    source.replace('kfunc:udp_sendmsg','kprobe:udp_sendmsg')):
            with self.assertRaises(RuntimeError):check_coverage(bad)


class RawBtfTests(unittest.TestCase):
    def blob(self,hidden_type):
        strings=b'\0long\0pt_regs\0btf_trace_sys_enter\0'
        types=struct.pack('<IIII',1,1<<24,8,(1<<24)|64)
        types+=struct.pack('<III',6,4<<24,128)
        types+=struct.pack('<III',0,2<<24,2)
        types+=struct.pack('<III',0,2<<24,0)
        types+=struct.pack('<III',0,(13<<24)|3,0)+b''.join(struct.pack('<II',0,value) for value in (hidden_type,3,1))
        types+=struct.pack('<III',0,2<<24,5)
        types+=struct.pack('<III',14,8<<24,6)
        return struct.pack('<HBBIIIII',0xeb9f,1,0,24,0,len(types),len(types),len(strings))+types+strings

    def test_typedef_pointer_prototype_strips_only_validated_hidden_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'btf';path.write_bytes(self.blob(4))
            self.assertEqual(btf_signature('sys_enter',path,tracepoint=True),{'parameters':['ptr:struct:pt_regs','s64'],'return':'void'})
            path.write_bytes(self.blob(1))
            with self.assertRaisesRegex(RuntimeError,'data_parameter_invalid'):btf_signature('sys_enter',path,tracepoint=True)
            with self.assertRaisesRegex(RuntimeError,'missing_or_ambiguous'):btf_signature('missing',path,tracepoint=True)
