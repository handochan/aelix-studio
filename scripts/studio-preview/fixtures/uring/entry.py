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
import struct


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


def btf_signature(symbol, path=Path('/sys/kernel/btf/vmlinux'), *, first_parameter=None):
    """Validate actual BTF parameter types, independent of fentry/list formatting."""
    raw=path.read_bytes()
    if not 24<=len(raw)<=64*1024*1024: raise RuntimeError('kernel_signature_btf_invalid')
    endian='<' if raw[:2]==b'\x9f\xeb' else '>' if raw[:2]==b'\xeb\x9f' else None
    if endian is None: raise RuntimeError('kernel_signature_btf_invalid')
    _,version,_,header,type_off,type_len,str_off,str_len=struct.unpack_from(endian+'HBBIIIII',raw)
    start,end=header+type_off,header+type_off+type_len
    strings=raw[header+str_off:header+str_off+str_len]
    if version!=1 or header<24 or not header<=start<=end<=len(raw) or len(strings)!=str_len:
        raise RuntimeError('kernel_signature_btf_invalid')
    def name(offset):
        if not 0<=offset<len(strings): raise RuntimeError('kernel_signature_btf_string_invalid')
        stop=strings.find(b'\0',offset)
        if stop<0: raise RuntimeError('kernel_signature_btf_string_invalid')
        return strings[offset:stop].decode('ascii')
    fixed={0:0,1:4,2:0,3:12,7:0,8:0,9:0,10:0,11:0,12:0,14:4,16:0,17:4,18:0}
    variable={4:12,5:12,6:8,13:8,15:12,19:12}
    types={};functions=[];identifier=1
    while start<end:
        if start+12>end: raise RuntimeError('kernel_signature_btf_truncated')
        label,info,value=struct.unpack_from(endian+'III',raw,start)
        kind=(info>>24)&31;count=info&65535
        if kind not in fixed and kind not in variable: raise RuntimeError('kernel_signature_btf_kind_unsupported')
        extra=fixed.get(kind,variable.get(kind,0)*count)
        if start+12+extra>end: raise RuntimeError('kernel_signature_btf_truncated')
        item={'kind':kind,'value':value,'name':name(label)}
        if kind==1:
            encoding=struct.unpack_from(endian+'I',raw,start+12)[0]
            item['signed']=bool(encoding&(1<<24))
            item['naturalInteger']=(encoding&0xffffff)==value*8
        if kind==13:item['args']=[struct.unpack_from(endian+'II',raw,start+12+i*8)[1] for i in range(count)]
        types[identifier]=item
        if kind==12 and item['name']==symbol:functions.append(value)
        start+=12+extra;identifier+=1
    if len(functions)!=1: raise RuntimeError('kernel_probe_btf_function_missing')
    def resolve(identifier,seen=None):
        seen=set() if seen is None else seen
        if identifier==0:return 'void'
        if identifier in seen or identifier not in types: raise RuntimeError('kernel_signature_btf_reference_invalid')
        seen.add(identifier);item=types[identifier]
        if item['kind'] in (8,9,10,11,18):return resolve(item['value'],seen)
        if item['kind']==2:return 'ptr:'+resolve(item['value'],seen)
        if item['kind']==4:return 'struct:'+item['name']
        if item['kind']==1:return ('s' if item['signed'] else 'u')+str(item['value']*8) if item['naturalInteger'] else 'unsupported'
        if item['kind']==13:return 'function'
        return 'unsupported'
    prototype=types.get(functions[0],{})
    if prototype.get('kind')!=13: raise RuntimeError('kernel_signature_btf_prototype_invalid')
    shape={'parameters':[resolve(value) for value in prototype['args']], 'return':resolve(prototype['value'])}
    valid=(first_parameter is not None and shape['parameters'] and shape['parameters'][0]==first_parameter or
           first_parameter is None and (
           symbol=='syscall_trace_enter' and shape['parameters'] and shape['parameters'][0]=='ptr:struct:pt_regs' or
           symbol=='ptrace_notify' and shape['parameters']==['s32','u64'] or
           symbol=='do_task_dead' and shape=={'parameters':[],'return':'void'} or
           symbol=='create_io_thread' and shape['return']=='ptr:struct:task_struct'))
    if not valid: raise RuntimeError('kernel_probe_btf_signature_mismatch')
    return shape
