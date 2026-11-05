"""Verified raw tracepoint ABI; classic /format payloads are not raw arguments.

Linux 6.8/7.0 raw TP programs use a per-program recursion context, unlike the
CPU-global guard of classic tracepoint/kprobe programs. Every miss stays fatal.
"""
import platform
import re

SHAPES = {
    'sys_enter': [('ptr:struct:pt_regs','s64')],
    'sys_exit': [('ptr:struct:pt_regs','s64')],
    'sched_process_exec': [('ptr:struct:task_struct','s32','ptr:struct:linux_binprm')],
    'sched_process_fork': [('ptr:struct:task_struct','ptr:struct:task_struct')],
    'sched_process_exit': [('ptr:struct:task_struct',),('ptr:struct:task_struct','u8')],
    'io_uring_create': [('s32','ptr:void','u32','u32','u32')],
    'io_uring_submit_req': [('ptr:struct:io_kiocb',)],
    'io_uring_req_failed': [('ptr:struct:io_uring_sqe','ptr:struct:io_kiocb','s32')],
    'io_uring_complete': [('ptr:void','ptr:void','u64','s32','u32','u64','u64'),
                          ('ptr:struct:io_ring_ctx','ptr:void','ptr:struct:io_uring_cqe')],
}


def validate(shapes, submit):
    if submit!='io_uring_submit_req' or set(shapes)!=set(SHAPES):
        raise RuntimeError('kernel_raw_tracepoint_schema_unsupported')
    for name,shape in shapes.items():
        if shape.get('return')!='void' or tuple(shape.get('parameters',[])) not in SHAPES[name]:
            raise RuntimeError('kernel_raw_tracepoint_signature_mismatch_'+name)
    return shapes


def requirements(submit):
    from uring.entry import btf_signature
    return validate({name:btf_signature(name,tracepoint=True) for name in SHAPES},submit)


def coverage():
    from uring.socketProgram import definitions
    from uring.network import SOCKET_HOOKS,FILE_WRITE_HOOKS
    return {'tracing':len(definitions())+len(SOCKET_HOOKS)+len(FILE_WRITE_HOOKS)+3,
            'raw':len(SHAPES),'interval':1}


def convert(source, submit, architecture=None):
    """Preserve TP_fast_assign semantics without reading user ptrace registers."""
    if submit!='io_uring_submit_req':raise RuntimeError('kernel_raw_submission_event_unsupported')
    architecture=architecture or platform.machine()
    registers={'x86_64':('orig_ax','di'),'aarch64':('syscallno','orig_x0')}.get(architecture)
    if registers is None:raise RuntimeError('kernel_raw_architecture_unsupported')
    number,first=registers
    req='((struct io_kiocb*)arg0)'
    failed='((struct io_kiocb*)arg1)'
    fields={
        'sys_enter':{'id':'(int64)arg1','args[0]':'((struct pt_regs*)arg0)->'+first},
        'sys_exit':{'id':'((struct pt_regs*)arg0)->'+number,'ret':'(int64)arg1'},
        'sched_process_exec':{},
        'sched_process_fork':{'parent_pid':'((struct task_struct*)arg0)->pid',
                              'child_pid':'((struct task_struct*)arg1)->pid'},
        'sched_process_exit':{},
        'io_uring_create':{'fd':'(int32)arg0','ctx':'arg1','flags':'(uint32)arg4'},
        'io_uring_submit_req':{'ctx':req+'->ctx','req':'arg0','opcode':req+'->opcode',
                               'sq_thread':'(('+req+'->ctx->flags & 2)!=0)'},
        'io_uring_req_failed':{'ctx':failed+'->ctx','req':'arg1',
                              'opcode':'((struct io_uring_sqe*)arg0)->opcode'},
        # Completion's request may already be dead; only copy its scalar value.
        'io_uring_complete':{'ctx':'arg0','req':'arg1'},
    }
    parts=re.split(r'(?m)(?=^(?:tracepoint:|kprobe:|kretprobe:|kfunc:|kretfunc:|rawtracepoint:|interval:|BEGIN\b|END\b))',source)
    observed=[]
    for index,part in enumerate(parts):
        match=re.match(r'^tracepoint:([^: ]+):(\w+)',part)
        if not match:continue
        category,name=match[1],match[2]
        if (category not in ('sched','raw_syscalls','io_uring') or name not in fields or name in observed):
            raise RuntimeError('kernel_raw_tracepoint_source_unsupported')
        observed.append(name)
        part='rawtracepoint:'+name+part[match.end():]
        for field,value in sorted(fields[name].items(),key=lambda pair:len(pair[0]),reverse=True):
            part=part.replace('args->'+field,'('+value+')')
        if 'args->' in part:raise RuntimeError('kernel_raw_tracepoint_field_unverified')
        parts[index]=part
    if set(observed)!=set(SHAPES):raise RuntimeError('kernel_raw_tracepoint_source_incomplete')
    return ''.join(parts)


def check_coverage(source):
    expected=coverage()
    actual={'tracing':len(re.findall(r'(?m)^k(?:ret)?func:',source)),
            'raw':len(re.findall(r'(?m)^rawtracepoint:',source)),
            'interval':len(re.findall(r'(?m)^interval:',source))}
    if actual!=expected or re.search(r'(?m)^(?:tracepoint|kprobe|kretprobe):',source):
        raise RuntimeError('kernel_recorder_provider_coverage_invalid')
    return expected
