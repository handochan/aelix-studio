"""Probe Linux io_uring tracepoint recording before installer qualification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile


CREATE_FIELDS = ('ctx', 'fd', 'flags', 'sq_entries', 'cq_entries')
SUBMIT_FIELDS = ('ctx', 'req', 'opcode', 'sq_thread')


def event_fields(text):
    return set(re.findall(r'field:[^;\n]*\b(\w+)\s*;', text))


def event_formats(root):
    create = root / 'events/io_uring/io_uring_create/format'
    submit = next((root / f'events/io_uring/{name}/format' for name in
                   ('io_uring_submit_req', 'io_uring_submit_sqe')
                   if (root / f'events/io_uring/{name}/format').is_file()), None)
    if not create.is_file() or submit is None:
        raise RuntimeError('required_io_uring_tracepoint_missing')
    texts = {'io_uring_create': create.read_text(), submit.parent.name: submit.read_text()}
    if not set(CREATE_FIELDS) <= event_fields(texts['io_uring_create']):
        raise RuntimeError('io_uring_create_fields_missing')
    if not set(SUBMIT_FIELDS) <= event_fields(texts[submit.parent.name]):
        raise RuntimeError('io_uring_submit_fields_missing')
    return submit.parent.name, texts


def pid_numbers_offset():
    """Read the running kernel BTF layout; never hardcode architecture offsets."""
    data=json.loads(subprocess.check_output(['bpftool','-j','btf','dump','file',
                                            '/sys/kernel/btf/vmlinux','format','raw']))
    for item in data['types']:
        if item.get('kind')=='STRUCT' and item.get('name')=='pid':
            for member in item['members']:
                if member['name']=='numbers' and member['bits_offset'] % 8 == 0:
                    return member['bits_offset']//8
    raise RuntimeError('pid_namespace_btf_layout_missing')


CONTROL_C = r'''
#include <liburing.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <stdio.h>
int main(int argc, char **argv) {
    alarm(15);
    struct io_uring ring;
    printf("PROBE_PID %d\n",getpid());fflush(stdout);
    int result=io_uring_queue_init(8,&ring,argc>1 ? IORING_SETUP_SQPOLL : 0);
    if(result<0){printf("SETUP_DENIED %d\n",result);return 77;}
    int fd=socket(AF_INET,SOCK_STREAM,0);
    struct sockaddr_in peer={.sin_family=AF_INET,.sin_port=htons(9)};
    inet_pton(AF_INET,"127.0.0.1",&peer.sin_addr);
    io_uring_prep_connect(io_uring_get_sqe(&ring),fd,(void*)&peer,sizeof(peer));
    if(io_uring_submit(&ring)!=1)return 78;
    struct io_uring_cqe *completion;
    if(io_uring_wait_cqe(&ring,&completion)<0)return 79;
    io_uring_cqe_seen(&ring,completion);close(fd);io_uring_queue_exit(&ring);return 0;
}
'''


def probe(output, sqpoll=False):
    report = {'schema': 'aelix.io-uring-trace-probe/1', 'status': 'failed',
              'kernel': os.uname().release, 'uid': os.getuid(), 'tool': 'bpftrace', 'sqpoll': sqpoll}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    try:
        if os.geteuid() != 0: raise RuntimeError('sudo_required')
        for command in ('bpftrace', 'bpftool', 'strace', 'cc'):
            if not shutil.which(command): raise RuntimeError('missing_tool_' + command)
        with tempfile.TemporaryDirectory(prefix='aelix-uring-probe-') as directory:
            temporary = Path(directory)
            root = Path('/sys/kernel/tracing')
            mounted = False
            if not (root / 'events').is_dir():
                root.mkdir(parents=True, exist_ok=True)
                subprocess.run(['mount','-t','tracefs','tracefs',str(root)],check=True,capture_output=True)
                mounted = True
            try:
                submit, formats = event_formats(root)
                report.update(tracepoints=list(formats), formatSha256={
                    name: hashlib.sha256(text.encode()).hexdigest() for name,text in formats.items()},
                    btfAvailable=Path('/sys/kernel/btf/vmlinux').is_file())
                report['toolVersion'] = subprocess.check_output(['bpftrace','--version'],text=True).strip()
                source=temporary/'control.c';source.write_text(CONTROL_C)
                binary=temporary/'control'
                subprocess.run(['cc',str(source),'-o',str(binary),'-luring'],check=True,capture_output=True)
                program=temporary/'probe.bt'
                offset=pid_numbers_offset()
                program.write_text('''
tracepoint:sched:sched_process_fork {
  $t=(struct task_struct*)curtask;
  $level=$t->thread_pid->level;
  $up=(struct upid*)((uint64)$t->thread_pid+PID_NUMBERS_OFFSET+$level*sizeof(struct upid));
  if (@tracked[args->parent_pid] || ((uint32)$up->nr == cpid && $up->ns->ns.inum == AUDITOR_NAMESPACE)) {
    @tracked[args->parent_pid]=1; @tracked[args->child_pid]=1;
  }
}
tracepoint:io_uring:io_uring_create {
  $t=(struct task_struct*)curtask;
  $level=$t->thread_pid->level;
  $up=(struct upid*)((uint64)$t->thread_pid+PID_NUMBERS_OFFSET+$level*sizeof(struct upid));
  if (@tracked[tid] || ((uint32)$up->nr == cpid && $up->ns->ns.inum == AUDITOR_NAMESPACE)) {
    @ctx[(uint64)args->ctx]=1;
    printf("CREATE %d %d %llu %d %u %u %d %u\\n",pid,tid,(uint64)args->ctx,args->fd,args->flags,$level,$up->nr,$up->ns->ns.inum);
  }
}
tracepoint:io_uring:SUBMIT /@ctx[(uint64)args->ctx]/ {
  printf("SUBMIT %d %d %llu %u %u\\n",pid,tid,(uint64)args->ctx,args->opcode,args->sq_thread);
}
END { clear(@ctx); clear(@tracked); }
'''.replace('SUBMIT /',submit+' /').replace('PID_NUMBERS_OFFSET',str(offset))
                    .replace('AUDITOR_NAMESPACE',str(os.stat('/proc/self/ns/pid').st_ino)))
                trace=temporary/'strace'
                result=subprocess.run(['bpftrace','-q','-B','line',str(program),'-c',
                    shlex.join([shutil.which('strace'), '-f', '--decode-pids=comm,pidns', '-q', '-s', '0',
                        '-e', 'trace=io_uring_setup,io_uring_enter,io_uring_register', '-o', str(trace), '--', str(binary),
                        *(['sqpoll'] if sqpoll else [])])],
                    capture_output=True,text=True,timeout=60)
                report['recorderExitCode']=result.returncode
                # Keep bounded diagnostic output, with raw kernel pointers and
                # task/file paths excluded from the published probe report.
                report['diagnostics']=[re.sub(r'0x[0-9a-fA-F]+','<address>',line.replace(str(temporary),'<probe>'))[:240]
                                       for line in result.stderr.splitlines()][:24]
                if result.returncode or re.search(r'\blost\b|\bdropped\b',result.stderr,re.I):
                    raise RuntimeError('bpf_recording_failed')
                creates=[line.split() for line in result.stdout.splitlines() if line.startswith('CREATE ')]
                submits=[line.split() for line in result.stdout.splitlines() if line.startswith('SUBMIT ')]
                marker=re.search(r'PROBE_PID (\d+)',result.stdout)
                denied=re.search(r'SETUP_DENIED (-?\d+)',result.stdout)
                if denied:
                    report['controlSetupError']=int(denied[1])
                    raise RuntimeError('control_io_uring_setup_denied')
                if not marker or len(creates)!=1: raise RuntimeError('create_event_not_observed')
                creator=int(creates[0][1]);tid=int(creates[0][2]);fd=int(creates[0][4]);nspid=int(creates[0][7])
                if nspid!=int(marker[1]): raise RuntimeError('namespace_pid_mismatch')
                raw=trace.read_text()
                if not re.search(rf'^{nspid}(?:<[^>]*>)? .*io_uring_setup\(.*\)\s+=\s+{fd}\b',raw,re.M):
                    raise RuntimeError('strace_create_mismatch')
                ops=[int(line[4]) for line in submits if line[3]==creates[0][3]]
                if 16 not in ops: raise RuntimeError('connect_opcode_not_observed')
                if sqpoll and not all(int(line[5])==1 and int(line[2])!=tid for line in submits):
                    raise RuntimeError('sqpoll_context_attribution_missing')
                report.update(status='passed', creatorPid=nspid, creatorTgid=nspid,
                    creatorKernelPid=tid, creatorKernelTgid=creator,
                    namespacePid=nspid, namespaceLevel=int(creates[0][6]), namespaceInode=int(creates[0][8]),
                    ringCount=len(creates), opcodeCounts={str(op):ops.count(op) for op in sorted(set(ops))},
                    submitters=[{'kernelPid':int(line[2]), 'kernelTgid':int(line[1]),
                                 'opcode':int(line[4]), 'sqpoll':bool(int(line[5]))} for line in submits],
                    straceMatched=True, samePidNamespace=creator==nspid,
                    pidNormalization='kernel-init-to-auditor-pid-namespace')
            finally:
                if mounted: subprocess.run(['umount',str(root)],check=True,capture_output=True)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        report['reason']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
    output.write_text(json.dumps(report,indent=2)+'\n')
    return 0 if report['status']=='passed' else 87


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--probe',type=Path,required=True)
    parser.add_argument('--sqpoll',action='store_true')
    args=parser.parse_args()
    raise SystemExit(probe(args.probe.resolve(),args.sqpoll))
