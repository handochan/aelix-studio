"""Prove UDP no-transmission associations with kernel socket generations.

No FD table inference establishes D. Pointer values stay private; reports use
opaque IDs. A final destructor callback may run outside the audited lineage,
whereas every actual socket user must have a verified task identity.
"""
from collections import defaultdict
import hashlib


def reconcile(capture, network, states, selected, connect_keys, required_udp=()):
    channel = (capture or {}).get('udpObjects')
    empty = dict(verified=False, exempt=set(), writes=[], issues=[], objects=[])
    if not isinstance(channel, dict):
        return empty
    issues = []
    def error(reason, pid=None, **metadata):
        item = dict(reason=reason, **metadata)
        if pid in states: item['pid'] = pid
        if item not in issues: issues.append(item)
    from uring.socketProgram import definitions
    from uring.rawTrace import coverage
    loss=capture.get('udpProbeLoss') or {};hooks=loss.get('hooks') or {};programs=loss.get('programs') or []
    expected=coverage()
    loss_valid=(loss.get('complete') is True and loss.get('mode')=='raw-tracepoint-and-btf-fentry-fexit' and hooks==definitions() and
                loss.get('coverage')==expected and len(programs)==sum(expected.values()) and
                all(isinstance(item,dict) and isinstance(item.get('prog_id'),int) and item['prog_id']>0 and
                    item.get('prog_type') in (7,17,26) and item.get('recursion_misses')==0 for item in programs) and
                len({item['prog_id'] for item in programs})==len(programs) and
                all(sum(item['prog_type']==kind for item in programs)==expected[label]
                    for kind,label in [(26,'tracing'),(17,'raw'),(7,'interval')]))
    if (not loss_valid or not capture.get('complete') or capture.get('lostEvents') != 0 or
            not capture.get('pidNamespaceVerified') or channel.get('schema') != 1 or
            not isinstance(capture.get('namespaceInode'),int) or capture['namespaceInode']<=0 or
            not isinstance((capture.get('root') or {}).get('time'),int) or capture['root']['time']<=0 or
            not channel.get('complete') or channel.get('eventCount') != len(channel.get('events', []))):
        error('udp_socket_capture_incomplete')
        return {**empty, 'issues': issues}
    tasks = {task['kernelPid']: task for task in capture.get('network', {}).get('tasks', [])}
    operations = {(op['pid'], op['ordinal']): op for op in (network or {}).get('operationDiagnostics', [])}
    by_key = {}; live = {}; matched = defaultdict(list); writes = []; orphan = False
    def actor(event):
        nonlocal orphan
        task = tasks.get(event['kernelPid'])
        if (not task or task['pid'] != event['pid'] or task['tgid'] != event['tgid'] or
                task['kernelTgid'] != event['kernelTgid'] or not task['start'] <= event['time'] <= task['end']):
            error('udp_socket_actor_unattributed', event['pid']); orphan = True
            return None
        seen = set()
        while task.get('kernelThread') or task.get('ioWorker'):
            if task['kernelPid'] in seen or task.get('parentKernelPid') not in tasks:
                error('udp_socket_worker_owner_unattributed'); orphan = True
                return None
            seen.add(task['kernelPid']); task = tasks[task['parentKernelPid']]
        if task['pid'] not in states:
            error('udp_socket_actor_outside_lineage'); orphan = True
            return None
        return task['pid']
    events = channel.get('events', [])
    for event in sorted(events, key=lambda item: item.get('time', -1)):
        fields = ('socket', 'generation', 'time', 'family', 'pid', 'tgid', 'kernelPid', 'kernelTgid',
                  'ordinal', 'call', 'fd', 'hook')
        if (any(not isinstance(event.get(field), int) for field in fields) or event['socket'] <= 0 or
                event['time'] <= 0 or event['generation'] < 0 or event['family'] not in (2, 10)):
            error('udp_socket_event_invalid'); orphan = True
            continue
        kind = event.get('kind'); key = (event['socket'], event['generation'])
        hook_kinds={'B':{0},'C':{1},'S':{2,3},'U':{4,5,6},'L':{7,8,9,10},'Q':{0},'F':{0}}
        if kind not in hook_kinds or event['hook'] not in hook_kinds[kind]:
            error('udp_socket_hook_invalid');orphan=True;continue
        if kind in ('Q','F') and any(event[field] for field in
                ('kernelPid','kernelTgid','pid','tgid','ordinal','call','fd')):
            error('udp_socket_destructor_record_invalid');orphan=True;continue
        obj = by_key.get(key)
        if kind == 'B':
            pid = actor(event)
            task=tasks.get(event['kernelPid']) or {}
            if (obj or event['socket'] in live or not capture['root']['time']<=event['generation']<=event['time'] or
                    not task.get('start',event['time']+1)<=event['generation']):
                error('udp_socket_generation_invalid', pid); orphan = True
                continue
            obj = dict(id='udp-' + hashlib.sha256(
                f"{capture.get('namespaceInode')}:{key[0]}:{key[1]}".encode()).hexdigest()[:24],
                family=event['family'], createdAt=event['generation'], initializedAt=event['time'],
                creatorPid=pid,creatorKernelPid=event['kernelPid'],
                actors=set(), connects=[], sends=[], valid=True)
            by_key[key] = obj; live[event['socket']] = key
            if pid is not None: obj['actors'].add(pid)
            continue
        if kind not in ('C', 'S', 'L', 'U', 'Q', 'F'):
            error('udp_socket_event_kind_unknown'); orphan = True
            continue
        if obj is None:
            # A socket made before the recorder/lineage began is not eligible,
            # even if a later connect/send has a fully interpreted syscall.
            pid = actor(event) if kind in ('C', 'S', 'L', 'U') else None
            error('udp_socket_birth_unproven', pid); orphan = True
            continue
        if event['family'] != obj['family'] or event['time'] < obj['initializedAt']:
            error('udp_socket_generation_metadata_mismatch'); obj['valid'] = False
        if kind == 'Q':
            if live.get(event['socket']) != key or 'destroyingAt' in obj:
                error('udp_socket_destructor_entry_invalid'); obj['valid'] = False
            obj['destroyingAt'] = event['time']; live.pop(event['socket'], None)
            continue
        if kind == 'F':
            if 'destroyingAt' not in obj or 'freedAt' in obj or event['time'] < obj['destroyingAt']:
                error('udp_socket_destructor_return_invalid'); obj['valid'] = False
            obj['freedAt'] = event['time']
            continue
        pid = actor(event)
        if pid is not None: obj['actors'].add(pid)
        if live.get(event['socket']) != key or 'destroyingAt' in obj:
            error('udp_socket_use_after_destructor', pid); obj['valid'] = False
        if kind == 'U': continue
        operation = operations.get((event['pid'], event['ordinal']))
        corresponding = (operation is not None and operation['kernelPid'] == event['kernelPid'] and
            operation['kernelTgid'] == event['kernelTgid'] and operation['tgid'] == event['tgid'] and
            operation['call'] == event['call'] and operation['entryTime'] <= event['time'] <= operation['returnTime'])
        if kind == 'C':
            if not corresponding or event['call'] != 1 or operation['fd'] != event['fd']:
                error('udp_socket_connect_strace_unmatched', pid); obj['valid'] = False
                continue
            origin = (event['pid'], operation['sequence'])
            if origin in connect_keys:
                matched[origin].append(key)
                obj['connects'].append(dict(pid=origin[0], sequence=origin[1], time=event['time'],
                    kernelPid=event['kernelPid'], ordinal=event['ordinal'],
                    rangeStart=operation['entryTime'], rangeEnd=operation['returnTime']))
        else:
            sequence = operation['sequence'] if corresponding else None
            obj['sends'].append(dict(pid=pid, kernelPid=event['kernelPid'], time=event['time'],
                                    sequence=sequence, ordinal=event['ordinal'], call=event['call'], hook=event['hook'],
                                    layer='protocol' if kind=='S' else 'ip-output'))
    exempt = set(); proofs = []
    for origin in required_udp:
        if len(matched[origin]) != 1:error('udp_socket_connect_evidence_missing', origin[0])
    for key, obj in by_key.items():
        owners = obj['actors']; selected_owners = owners & selected
        if selected_owners and owners - selected:
            for pid in selected_owners: error('udp_socket_cross_scope', pid)
            obj['valid'] = False
        if obj['connects'] and 'freedAt' not in obj:
            for connect in obj['connects']: error('udp_socket_release_unobserved', connect['pid'])
            obj['valid'] = False
        for connect in obj['connects']:
            origin = (connect['pid'], connect['sequence'])
            if len(matched[origin]) != 1:
                error('udp_socket_connect_ambiguous', connect['pid']); obj['valid'] = False
            if obj['valid'] and not obj['sends']: exempt.add(origin)
        for send in obj['sends']:
            writes.append(dict(**send, connects=[(item['pid'], item['sequence']) for item in obj['connects']],
                               objectId=obj['id']))
        proofs.append({name: value for name, value in obj.items() if name != 'actors'} | {'actorPids': sorted(owners)})
    # A single incomplete object channel or unreconciled kernel operation must
    # never authorize an exemption for a different socket in the same trace.
    verified = not orphan and not issues
    if not verified or (network or {}).get('issues'): exempt.clear()
    return dict(verified=verified, exempt=exempt, writes=writes, issues=issues, objects=proofs)


RETENTION_MODES = ('object-preexisting', 'object-unreleased')
LOOPBACK_MODES = ('loopback-ipv4-send','loopback-ipv6-send')
CONTROL_MODES = ('fionclex-exec-exit', 'fionclex-exec-send', 'scm-rights-send', 'pidfd-getfd-send', *LOOPBACK_MODES, *RETENTION_MODES)

CONTROL_C = r'''
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
static int connection(void) {
  int fd=socket(AF_INET,SOCK_DGRAM|SOCK_CLOEXEC,0);
  if(fd<0)exit(20);
  struct sockaddr_in peer={.sin_family=AF_INET,.sin_port=htons(443)};
  inet_pton(AF_INET,"203.0.113.1",&peer.sin_addr);
  if(connect(fd,(void*)&peer,sizeof(peer)) && errno!=ENETUNREACH)exit(21);
  return fd;
}
static void transmit(int fd) {
  if(send(fd,"control",7,0)<0 && errno!=EDESTADDRREQ && errno!=ENETUNREACH)exit(22);
}
static int reap(pid_t child) {
  int status;if(waitpid(child,&status,0)!=child || !WIFEXITED(status))return 23;
  return WEXITSTATUS(status);
}
int main(int argc,char **argv) {
  alarm(15);
  if(argc==4 && !strcmp(argv[1],"exec-child")) {
    int fd=atoi(argv[2]);
    if(fcntl(fd,F_GETFD)<0 || fcntl(fd,F_GETFD)&FD_CLOEXEC)return 24;
    if(!strcmp(argv[3],"send"))transmit(fd);
    /* Intentionally leave the FD open until exit_files. */
    return 0;
  }
  if(argc!=2)return 25;
  if(!strncmp(argv[1],"fionclex-",9)) {
    int fd=connection();if(ioctl(fd,FIONCLEX))return 26;
    pid_t child=fork();if(child<0)return 27;
    if(!child) {
      char number[32];snprintf(number,sizeof(number),"%d",fd);
      execl("/proc/self/exe","object-control","exec-child",number,
        !strcmp(argv[1],"fionclex-exec-send")?"send":"exit",NULL);
      _exit(28);
    }
    close(fd);return reap(child);
  }
  if(!strcmp(argv[1],"scm-rights-send")) {
    int pair[2];if(socketpair(AF_UNIX,SOCK_DGRAM|SOCK_CLOEXEC,0,pair))return 29;
    int fd=connection();pid_t child=fork();if(child<0)return 30;
    char data=0,control[CMSG_SPACE(sizeof(int))]={0};
    struct iovec iov={.iov_base=&data,.iov_len=1};
    struct msghdr message={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof(control)};
    if(!child) {
      close(pair[0]);close(fd);
      if(recvmsg(pair[1],&message,0)!=1)_exit(31);
      struct cmsghdr *header=CMSG_FIRSTHDR(&message);
      if(!header || header->cmsg_level!=SOL_SOCKET || header->cmsg_type!=SCM_RIGHTS)_exit(32);
      memcpy(&fd,CMSG_DATA(header),sizeof(fd));transmit(fd);return 0;
    }
    close(pair[1]);struct cmsghdr *header=CMSG_FIRSTHDR(&message);
    header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN(sizeof(fd));
    memcpy(CMSG_DATA(header),&fd,sizeof(fd));
    if(sendmsg(pair[0],&message,0)!=1)return 33;
    close(fd);close(pair[0]);return reap(child);
  }
  if(!strcmp(argv[1],"pidfd-getfd-send")) {
    int ready[2],done[2];if(pipe(ready) || pipe(done))return 34;
    pid_t child=fork();if(child<0)return 35;
    if(!child) {
      close(ready[0]);close(done[1]);int fd=connection();
      if(write(ready[1],&fd,sizeof(fd))!=sizeof(fd))_exit(36);
      char value;if(read(done[0],&value,1)!=1)_exit(37);return 0;
    }
    close(ready[1]);close(done[0]);int number;
    if(read(ready[0],&number,sizeof(number))!=sizeof(number))return 38;
    int pidfd=syscall(SYS_pidfd_open,child,0);if(pidfd<0)return 39;
    int fd=syscall(SYS_pidfd_getfd,pidfd,number,0);if(fd<0)return 40;
    transmit(fd);close(fd);close(pidfd);
    if(write(done[1],"x",1)!=1)return 41;
    close(ready[0]);close(done[1]);return reap(child);
  }
  return 42;
}
'''


def control(mode):
    """Exercise real FD transfers inside the private control network namespace."""
    from pathlib import Path
    import subprocess
    import tempfile
    if mode not in CONTROL_MODES: raise ValueError('unknown_object_control')
    if mode in RETENTION_MODES:return retention_child(mode)
    if mode in LOOPBACK_MODES:
        import socket
        family=socket.AF_INET6 if mode=='loopback-ipv6-send' else socket.AF_INET
        if family==socket.AF_INET6:
            option=Path('/proc/sys/net/ipv6/conf/lo/disable_ipv6')
            if option.read_text().strip()!='0':option.write_text('0')
        with socket.socket(family,socket.SOCK_DGRAM) as receiver,socket.socket(family,socket.SOCK_DGRAM) as sender:
            receiver.bind(('::1' if family==socket.AF_INET6 else '127.0.0.1',0));receiver.settimeout(5)
            sender.connect(receiver.getsockname());sender.send(b'control')
            if receiver.recv(16)!=b'control':raise RuntimeError('udp_loopback_control_payload_missing')
        return 0
    with tempfile.TemporaryDirectory(prefix='udp-object-control-') as directory:
        source=Path(directory)/'control.c';binary=Path(directory)/'control'
        source.write_text(CONTROL_C)
        subprocess.run(['cc',str(source),'-o',str(binary)],check=True,capture_output=True)
        return subprocess.run([str(binary),mode],check=True).returncode


def retention_child(mode):
    """Exchange an FD with the verifier, which is outside the audited lineage."""
    import array
    import os
    import socket
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
        peer.connect(os.environ['AELIX_AUDIT_OBJECT_CONTROL_SOCKET'])
        if mode=='object-preexisting':
            _,ancillary,_,_=peer.recvmsg(1,socket.CMSG_SPACE(array.array('i').itemsize))
            descriptors=array.array('i')
            if len(ancillary)!=1 or ancillary[0][:2]!=(socket.SOL_SOCKET,socket.SCM_RIGHTS):
                raise RuntimeError('object_control_descriptor_missing')
            descriptors.frombytes(ancillary[0][2])
            if len(descriptors)!=1:raise RuntimeError('object_control_descriptor_ambiguous')
            connection=socket.socket(fileno=descriptors[0])
        else:connection=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
        with connection:
            try:connection.connect(('203.0.113.1',443))
            except OSError:pass
            if mode=='object-unreleased':
                peer.sendmsg([b'x'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[connection.fileno()]))])
                if peer.recv(1)!=b'x':raise RuntimeError('object_control_retention_unconfirmed')
    return 0


def retention_control(auditor,report,mode):
    """Hold the actual FD before collection or beyond its end; neither is D."""
    import array
    import os
    from pathlib import Path
    import socket
    import subprocess
    import sys
    import tempfile
    import threading
    release=threading.Event();errors=[]
    with tempfile.TemporaryDirectory(prefix='udp-object-retention-') as directory:
        path=Path(directory)/'control.sock'
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        listener.bind(str(path));listener.listen();listener.settimeout(0.2)
        original=socket.socket(socket.AF_INET,socket.SOCK_DGRAM) if mode=='object-preexisting' else None
        def exchange():
            held=[]
            try:
                peer=None
                while not release.is_set():
                    try:peer=listener.accept()[0];break
                    except socket.timeout:continue
                if peer is None:raise RuntimeError('object_control_not_connected')
                with peer:
                    peer.settimeout(60)
                    if original is not None:
                        peer.sendmsg([b'x'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[original.fileno()]))])
                        original.close()
                    else:
                        _,ancillary,_,_=peer.recvmsg(1,socket.CMSG_SPACE(array.array('i').itemsize))
                        if len(ancillary)!=1 or ancillary[0][:2]!=(socket.SOL_SOCKET,socket.SCM_RIGHTS):
                            raise RuntimeError('object_control_retention_missing')
                        descriptors=array.array('i');descriptors.frombytes(ancillary[0][2]);held.extend(descriptors)
                        if len(held)!=1:raise RuntimeError('object_control_retention_ambiguous')
                        peer.sendall(b'x')
                    if not release.wait(90):raise RuntimeError('object_control_retention_timeout')
            except Exception as exception:errors.append(type(exception).__name__)
            finally:
                for fd in held:os.close(fd)
        thread=threading.Thread(target=exchange);thread.start()
        try:
            command=['sudo','-n','env','AELIX_AUDIT_OBJECT_CONTROL_SOCKET='+str(path),
                     'unshare','--net','--','/bin/sh','-c',
                     'ip link set lo up && exec "$@"','udp-object-control',
                     sys.executable,'-I','-B',str(auditor),'--report',str(report),'--',
                     sys.executable,'-I','-B',str(auditor),'--udp-control',mode]
            result=subprocess.run(command)
        finally:
            release.set();thread.join(timeout=65);listener.close()
            if original is not None:original.close()
        if thread.is_alive() or errors:raise RuntimeError('object_control_exchange_failed')
        return result
