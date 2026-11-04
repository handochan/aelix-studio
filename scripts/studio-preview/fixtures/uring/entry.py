"""Select a verified kernel point before the tracer's register read.

Linux 7 x64 inlines syscall_trace_enter. ptrace_notify's syscall-entry stop
still precedes ptrace_stop, so the current task's saved registers are stable.
The task_pt_regs formula is Linux's own x64 macro, with running configuration
and BTF bounds checks, not a guessed stack offset.
"""
import gzip
import hashlib
import os
from pathlib import Path
import platform
import re


def stack_layout(text, release, page_size):
    version=re.match(r'^(\d+)\.(\d+)',release)
    if version is None or not (6,8)<=tuple(map(int,version.groups()))<=(7,0):
        raise RuntimeError('kernel_pre_entry_layout_version_unsupported')
    options={}
    for line in text.splitlines():
        match=re.fullmatch(r'(CONFIG_\w+)=(y|n)',line)
        disabled=re.fullmatch(r'# (CONFIG_\w+) is not set',line)
        if match:
            if match[1] in options: raise RuntimeError('kernel_config_duplicate')
            options[match[1]]=match[2]
        elif disabled:
            if disabled[1] in options: raise RuntimeError('kernel_config_duplicate')
            options[disabled[1]]='n'
    if (page_size!=4096 or options.get('CONFIG_X86_64')!='y' or options.get('CONFIG_VMAP_STACK')!='y' or
            any(options.get(key) not in ('y','n') for key in ('CONFIG_KASAN','CONFIG_X86_FRED'))):
        raise RuntimeError('kernel_pre_entry_stack_configuration_unsupported')
    return {'threadBytes':page_size << (2+(options['CONFIG_KASAN']=='y')),
            'paddingBytes':16 if options['CONFIG_X86_FRED']=='y' else 0,'pageBytes':page_size,
            'configSha256':hashlib.sha256(text.encode()).hexdigest()}


def select(available, architecture=None, release=None, configs=None):
    architecture=architecture or platform.machine()
    if 'syscall_trace_enter' in available:
        return {'symbol':'syscall_trace_enter','architecture':architecture}
    if architecture!='x86_64' or 'ptrace_notify' not in available:
        raise RuntimeError('kernel_pre_ptrace_probe_missing')
    release=release or os.uname().release
    configs=configs if configs is not None else [Path('/boot')/('config-'+release),Path('/proc/config.gz')]
    for path in configs:
        if path.is_file():
            raw=path.read_bytes()
            if len(raw)>4*1024*1024: raise RuntimeError('kernel_config_too_large')
            text=(gzip.decompress(raw) if path.suffix=='.gz' else raw).decode()
            if len(text)>4*1024*1024: raise RuntimeError('kernel_config_too_large')
            layout=stack_layout(text,release,os.sysconf('SC_PAGE_SIZE'))
            return dict(symbol='ptrace_notify',architecture=architecture,**layout)
    raise RuntimeError('kernel_pre_entry_running_config_missing')


def registers(entry):
    if entry['symbol']=='syscall_trace_enter': return '$r=(struct pt_regs*)arg0;'
    return '''
  $stack=(uint64)$t->stack;
  $area=(struct vm_struct*)$t->stack_vm_area;
  if (!$stack || (uint64)$area->addr!=$stack || (uint64)$area->nr_pages!=(uint64)PAGES) { @pre_layout_error=count(); }
  $r=(struct pt_regs*)($stack+THREAD_BYTES-PADDING_BYTES-sizeof(struct pt_regs));
'''.replace('PAGES',str(entry['threadBytes']//entry['pageBytes'])).replace(
        'THREAD_BYTES',str(entry['threadBytes'])).replace('PADDING_BYTES',str(entry['paddingBytes']))


def signature_valid(entry, signature):
    if entry['symbol']=='syscall_trace_enter':
        return bool(re.search(r'^\s+struct\s+pt_regs\s*\*\s*regs\s*$',signature,re.M))
    return bool(re.search(r'^\s+int\s+exit_code\s*$',signature,re.M) and
                re.search(r'^\s+unsigned\s+long\s+message\s*$',signature,re.M))
