"""Independent kernel network evidence; never infer an unreadable syscall number.

Only complete, uniquely attributable task lifetimes may discharge terminal
strace register-read failures. Pre-ptrace invocations prevent an emulated
seccomp result from substituting for a different, hidden executed invocation.
"""
from collections import defaultdict, deque
import re
import platform

CALLS = ('connect', 'sendto', 'sendmsg', 'sendmmsg', 'write', 'writev', 'accept', 'accept4')
SOCKET_ARGUMENTS = {'kernel_connect':'socket','sock_write_iter':'kiocb',
                    'sock_sendmsg':'socket','tcp_v4_connect':'sock','tcp_v6_connect':'sock',
                    'udp_sendmsg':'sock','udpv6_sendmsg':'sock','inet_sendmsg':'socket','inet6_sendmsg':'socket',
                    '__ip4_datagram_connect':'sock','__ip6_datagram_connect':'sock'}
SOCKET_HOOKS = tuple(SOCKET_ARGUMENTS)
FILE_WRITE_HOOKS = ('vfs_write','vfs_writev','eventfd_write')
HOOKS = (*SOCKET_HOOKS,*FILE_WRITE_HOOKS, 'create_io_thread')


def symbol_evidence(path=None):
    """Keep public alias names, never raw kernel addresses, in provenance."""
    from pathlib import Path
    path=path or Path('/proc/kallsyms')
    wanted={'security_socket_sendmsg','security_socket_recvmsg',
            'security_socket_connect','security_socket_bind','security_socket_getsockname','security_socket_getpeername'}
    addresses={}
    try:lines=path.read_text().splitlines()
    except OSError:return {'securityAliasGroups':[],'securityAddressesVisible':False}
    for line in lines:
        fields=line.split()
        if len(fields)>=3 and fields[2] in wanted:
            value=int(fields[0],16)
            if fields[2] in addresses and addresses[fields[2]]!=value:raise RuntimeError('kernel_symbol_identity_ambiguous')
            addresses[fields[2]]=value
    groups=[]
    for address in sorted(set(addresses.values())-{0}):
        names=sorted(name for name,value in addresses.items() if value==address)
        if len(names)>1:groups.append(names)
    return {'securityAliasGroups':groups,
            'securityAddressesVisible':all(addresses.get(name,0)>0 for name in wanted)}


def requirements(root):
    """Require every attachment and field; attachment itself is also checked."""
    formats = {}
    from uring.probe import event_fields
    for direction,fields in [('enter',{'id'}),('exit',{'id','ret'})]:
        path=root/f'events/raw_syscalls/sys_{direction}/format'
        if not path.is_file():raise RuntimeError('kernel_raw_syscall_tracepoint_missing_'+direction)
        value=path.read_text()
        if not fields<=event_fields(value):raise RuntimeError('kernel_raw_syscall_fields_missing_'+direction)
        if direction=='enter' and not re.search(r'field:[^;]*\bargs\s*\[\s*6\s*\]\s*;',value):
            raise RuntimeError('kernel_raw_syscall_arguments_missing')
        formats['raw_syscalls/sys_'+direction]=value
    path = root / 'available_filter_functions'
    available = {line.split()[0] for line in path.read_text().splitlines() if line.strip()}
    if not set(HOOKS) <= available:
        raise RuntimeError('kernel_socket_probe_missing_'+'_'.join(sorted(set(HOOKS)-available)))
    return formats


def program(normalize, pre_entry=None):
    """Record metadata only: task IDs, call, FD, return value and socket family."""
    architecture = platform.machine()
    # Native ABI only. Compatibility multiplexers must not bypass native
    # syscall decoding. Constants are kernel v6.8 arch/*/include/asm/thread_info.h:
    # x86 TS_COMPAT/TIF_ADDR32 and arm64 TIF_32BIT. Unknown architectures fail.
    if architecture == 'x86_64':
        incompatible = '($t->thread_info.status & 2) || ($t->thread_info.flags & (1 << 29)) || (args->id & 0x40000000)'
        registers = '$syscall=$r->orig_ax; $fd=$r->di;'
        numbers = (42,44,46,307,1,20,43,288)
    elif architecture == 'aarch64':
        incompatible = '$t->thread_info.flags & (1 << 22)'
        registers = '$syscall=$r->syscallno; $fd=$r->orig_x0;'
        numbers = (203,206,211,269,64,66,202,242)
    else:
        raise RuntimeError('kernel_network_architecture_unsupported')
    select = '\n'.join(f'  if ($syscall=={number}) {{ $call={index}; }}'
                       for index, number in enumerate(numbers, 1))
    source = r'''
tracepoint:raw_syscalls:sys_enter /@tracked[tid]/ {
  $t=(struct task_struct*)curtask;
  if (INCOMPATIBLE) { @unsupported_abi=count(); }
  if (@raw_active[tid] || @net_call[tid]) {
    @raw_state_overlap=count();
NORMALIZE
    printf("OVERLAP|%llu|%d|%d|%lld|%lld|%d|%llu\n",nsecs,tid,$nspid,@raw_id[tid],args->id,@net_call[tid],@pre_seq[tid]);
  }
  @raw_id[tid]=args->id; @raw_active[tid]=1;
  $syscall=args->id; $call=0;
SELECT
  if ($call) {
NORMALIZE
    if (!@pre_seq[tid] || @pre_call[tid]!=$call) { @pre_mismatch=count(); }
    @net_seq[tid]=@pre_seq[tid]; @net_call[tid]=$call;
    @net_fd[tid]=(int32)args->args[0];
    @network_count=count();
    printf("N|%llu|%d|%d|%d|%d|%d|%llu|%d|%d\n",nsecs,pid,tid,$nspid,$nstgid,$call,@net_seq[tid],@net_fd[tid],0);
  }
}
tracepoint:raw_syscalls:sys_exit /@tracked[tid]/ {
  if (@net_call[tid]) {
NORMALIZE
    if (!@raw_active[tid] || @raw_id[tid]!=args->id) { @network_return_id_error=count(); }
    @network_count=count();
    printf("X|%llu|%d|%d|%d|%d|%d|%llu|%d|%lld\n",nsecs,pid,tid,$nspid,$nstgid,@net_call[tid],@net_seq[tid],@net_fd[tid],args->ret);
    delete(@net_call[tid]); delete(@net_fd[tid]);
  }
  if (@raw_active[tid]) { delete(@raw_active[tid]); delete(@raw_id[tid]); }
}
'''.replace('INCOMPATIBLE',incompatible).replace('SELECT',select)
    from uring.entry import registers as pre_registers
    pre_entry=pre_entry or {'symbol':'syscall_trace_enter'}
    source += '''
kprobe:ENTRY /@tracked[tid] EXTRA/ {
NORMALIZE
  PRE_REGISTERS
  REGISTERS
  if (PRE_INCOMPATIBLE) { @unsupported_abi=count(); }
  @pre_seq[tid]=@pre_seq[tid]+1;
  $call=0;
SELECT
  @pre_call[tid]=$call;
  if ($call) {
    @network_count=count();
    printf("P|%llu|%d|%d|%d|%d|%d|%llu|%d|%d\\n",nsecs,pid,tid,$nspid,$nstgid,$call,@pre_seq[tid],(int32)$fd,0);
  }
}
'''.replace('PRE_REGISTERS',pre_registers(pre_entry)).replace('REGISTERS', registers).replace('SELECT', select).replace(
        'PRE_INCOMPATIBLE', incompatible.replace('args->id','$syscall')).replace('ENTRY',pre_entry['symbol']).replace(
        ' EXTRA',' && arg0==133 && arg1==1' if pre_entry['symbol']=='ptrace_notify' else '')
    for number, hook in enumerate(SOCKET_HOOKS, 1):
        kind=SOCKET_ARGUMENTS[hook]
        if kind=='sock':family='$emit=1; $sk=(struct sock*)arg0; $family=$sk->__sk_common.skc_family;'
        elif kind=='socket':family='$emit=1; $sock=(struct socket*)arg0; $family=$sock->sk->__sk_common.skc_family;'
        else:
            family='''$emit=1; $iocb=(struct kiocb*)arg0; $file=$iocb->ki_filp;
  $sock=(struct socket*)$file->private_data; $family=$sock->sk->__sk_common.skc_family;
'''
        source += '''
kprobe:HOOK /@tracked[tid]/ {
NORMALIZE
  FAMILY
  LAYOUT_CHECK
  if ($emit) {
  @network_count=count();
  $native=-1; if (@raw_active[tid]) { $native=@raw_id[tid]; }
  printf("H|%llu|%d|%d|%d|%d|%d|%llu|%d|%d|%lld\\n",nsecs,pid,tid,$nspid,$nstgid,@net_call[tid],@net_seq[tid],NUMBER,$family,$native);
  }
}
'''.replace('HOOK', hook).replace('FAMILY', family).replace('NUMBER', str(number)).replace(
        'LAYOUT_CHECK','if ($family==0) { @socket_layout_error=count(); }')
    for number,hook in enumerate(FILE_WRITE_HOOKS,1):
        source+='''
kprobe:HOOK /@tracked[tid] && (@net_call[tid]==5 || @net_call[tid]==6)/ {
NORMALIZE
  $file=(struct file*)arg0;
  @network_count=count();
  printf("V|%llu|%d|%d|%d|%d|%d|%llu|%d|%u|%llu\\n",nsecs,pid,tid,$nspid,$nstgid,@net_call[tid],@net_seq[tid],NUMBER,$file->f_inode->i_mode & 0xf000,(uint64)$file);
}
'''.replace('HOOK',hook).replace('NUMBER',str(number))
    return source.replace('NORMALIZE', normalize).replace('/@tracked[tid]', '/tid != @audit_root_tid && @tracked[tid]')


def parse(fields):
    if fields[0] not in ('P','N','X','H','V') or len(fields)!=(11 if fields[0] in ('H','V') else 10):
        raise ValueError('invalid_kernel_network_record')
    values = list(map(int, fields[1:10]))
    time, kernel_tgid, kernel_pid, pid, tgid, call, ordinal, value, result = values
    return dict(kind=fields[0], time=time, kernelTgid=kernel_tgid, kernelPid=kernel_pid,
                pid=pid, tgid=tgid, call=call, ordinal=ordinal, value=value, result=result,
                nativeSyscall=int(fields[10]) if fields[0]=='H' else None,
                file=int(fields[10]) if fields[0]=='V' else None)


def reconcile(capture, records, holes, states, ring_evidence, expected_tgids=None, expected_parents=None, terminal_pids=None, known_destinations=None, metadata_allowed=()):
    """Cross-check all kernel activity, even when strace has no decode failure."""
    issues = []; resolved = []; entries = defaultdict(list); tasks = {}; mapping = {}
    def error(reason, pid=None, **metadata):
        issue = {'reason': reason}
        if pid in states: issue['pid'] = pid
        elif pid is not None: issue['unattributedPid'] = pid
        issue.update(metadata)
        issues.append(issue)
    network = capture.get('network')
    if (not capture.get('complete') or capture.get('lostEvents') != 0 or
            not capture.get('pidNamespaceVerified') or not isinstance(network, dict) or
            not network.get('complete')):
        error('kernel_network_capture_incomplete')
        return dict(issues=issues, resolved=resolved, notExecuted=[], nonNetworkWrites=[], resultFields=[], metadataFields=[], eventCount=0)
    for task in network.get('tasks', []):
        pid = task['pid']
        if task['start'] <= 0 or task['start'] > task['end']:
            error('kernel_network_task_range_invalid', pid)
        if pid > 0 and pid in tasks or task['kernelPid'] in mapping:
            error('kernel_network_task_identity_reused', pid)
        if pid > 0: tasks[pid] = task
        mapping[task['kernelPid']] = task
    worker_births={}
    for event in network.get('workers', []):
        task=mapping.get(event['kernelPid'])
        if (event['kernelPid'] in worker_births or not task or not task.get('ioWorker') or
                (event['flags']&0x4010)!=0x4010 or event['parentKernelPid']!=task.get('parentKernelPid') or
                event['start']!=task['start'] or not task['start']<=event['time']<=task['end']):
            error('kernel_io_worker_birth_unattributed')
        worker_births[event['kernelPid']]=event
    for task in mapping.values():
        pid=task['pid']; kernel_pid=task['kernelPid']
        worker=lambda item: item.get('kernelThread',False) or item.get('ioWorker',False)
        if not worker(task):
            if pid not in states and kernel_pid != (capture.get('root') or {}).get('kernelPid'):
                # strace forks private ptrace capability probes before its
                # actual tracee. They are siblings, not descendants, of the
                # audited command. Decide solely from complete fork topology.
                seen=set(); current=task
                while current['kernelPid'] != (capture.get('root') or {}).get('kernelPid'):
                    if current['pid'] in states:
                        error('kernel_userspace_task_strace_missing'); break
                    if current['kernelPid'] in seen or current.get('parentKernelPid') not in mapping:
                        error('kernel_task_lineage_unattributed'); break
                    seen.add(current['kernelPid']); current=mapping[current['parentKernelPid']]
        else:
            if kernel_pid not in worker_births: error('kernel_worker_birth_missing')
            seen=set(); current=task
            while worker(current):
                if current['kernelPid'] in seen or current.get('parentKernelPid') not in mapping:
                    error('kernel_thread_lineage_unattributed'); break
                seen.add(current['kernelPid']); current=mapping[current['parentKernelPid']]
            if not worker(current) and not any(ring['creatorTgid']==current['tgid']
                    for ring in (ring_evidence or {}).get('rings', [])):
                error('kernel_worker_ring_owner_missing')
        leader=mapping.get(task.get('kernelTgid'))
        if not leader or leader['pid'] != task['tgid']:
            error('kernel_network_task_leader_mismatch',pid)
    for pid in states:
        if pid not in tasks: error('kernel_network_task_lifetime_missing', pid)
        elif expected_tgids is not None and expected_tgids.get(pid) != tasks[pid]['tgid']:
            error('kernel_network_tgid_mismatch', pid)
        if expected_parents is not None and pid in tasks:
            parent=mapping.get(tasks[pid].get('parentKernelPid'))
            expected=expected_parents.get(pid)
            if (parent is None or expected is not None and parent['pid']!=expected or
                    expected is None and parent['kernelPid']!=(capture.get('root') or {}).get('kernelPid')):
                error('kernel_strace_fork_parent_mismatch',pid)
    events = network.get('events', [])
    if network.get('eventCount') != len(events): error('kernel_network_event_count_mismatch')
    calls = {}; returns = {}; hooks = []; files=defaultdict(list); pre = defaultdict(list); pre_keys = {}
    for event in sorted(events, key=lambda item: item['time']):
        pid = event['pid']; task = mapping.get(event['kernelPid'])
        if (not task or task['kernelPid'] != event['kernelPid'] or
                task['pid'] != pid or task['tgid'] != event['tgid'] or task['kernelTgid'] != event['kernelTgid'] or
                not task['start'] <= event['time'] <= task['end']):
            error('kernel_network_event_unattributed', pid); continue
        if pid not in states and event['kind'] != 'H':
            error('kernel_network_task_strace_missing'); continue
        key = (pid, event['ordinal'])
        if event['kind'] == 'P':
            if (key in pre_keys or not 1 <= event['call'] <= len(CALLS) or event['ordinal']<=0 or
                    event['ordinal']>task.get('lastOrdinal',-1)):
                error('kernel_network_pre_entry_invalid', pid); continue
            pre_keys[key] = event; pre[pid].append(event)
        elif event['kind'] == 'N':
            if key in calls or not 1 <= event['call'] <= len(CALLS):
                error('kernel_network_entry_invalid', pid); continue
            before = pre_keys.get(key)
            if not before or (before['call'],before['value']) != (event['call'],event['value']):
                error('kernel_network_pre_entry_missing', pid)
            calls[key] = event; entries[pid].append(event)
        elif event['kind'] == 'X':
            entry = calls.get(key)
            if (key in returns or not entry or entry['call'] != event['call'] or entry['value'] != event['value']):
                error('kernel_network_return_unmatched', pid)
            returns[key] = event
        elif event['kind']=='V':
            if (event['call'] not in (5,6) or not 1<=event['value']<=len(FILE_WRITE_HOOKS) or
                    not isinstance(event.get('file'),int) or event['file']<=0):
                error('kernel_file_write_observation_invalid',pid)
            files[key].append(event)
        else:
            if not 1 <= event['value'] <= len(SOCKET_HOOKS) or event['result']<=0:
                error('kernel_socket_probe_invalid', pid)
            elif event['result'] not in (1,2,10,16):error('kernel_socket_family_unsupported',pid)
            hooks.append(event)
    decoded = defaultdict(deque); close_fields=[]; close_keys=set()
    for key,observed in files.items():
        entry=calls.get(key);returned=returns.get(key)
        for event in observed:
            if (not entry or event['call']!=entry['call'] or event['time']<entry['time'] or
                    returned and event['time']>returned['time']):
                error('kernel_file_write_context_invalid',event['pid'])
    for record in sorted(records,key=lambda item:item[2]):
        pid,line,sequence=record[:3]
        call = re.match(r'^(\w+)\(\s*(-?\d+)', line)
        result = re.search(r'\)\s+=\s+(-?\d+)(?:<.*>)?(?:\s.*)?$', line)
        if call and call[1] in CALLS:
            decoded[pid].append((CALLS.index(call[1])+1, int(call[2]), int(result[1]) if result else None, sequence))
        # Only the return is unreadable. A complete close entry cannot create an
        # FD alias; its unknown return must never be used as closure evidence.
        close=re.fullmatch(r'close\(\s*(-?\d+)(?:<.*>)?\s*\)\s+=\s+\?(?:\s.*)?',line)
        if close and (pid,sequence) in metadata_allowed:
            if (pid,sequence) in close_keys:
                error('kernel_metadata_record_duplicated',pid);continue
            close_keys.add((pid,sequence))
            close_fields.append((pid,sequence,int(close[1])))
    matched = set(); matched_sequences={}
    not_executed = defaultdict(list); nonexecution=[]; nonnetwork=[]; result_fields=[]
    terminal_pids=states if terminal_pids is None else terminal_pids
    def non_socket_write(event):
        key=(event['pid'],event['ordinal']);entered=calls.get(key);observed=files[key]
        if not entered or event['call'] not in (5,6) or any((e['pid'],e['ordinal'])==key for e in hooks):return False
        bases=[e for e in observed if e['value'] in (1,2)]
        if not bases:return False
        eventfds={e['file'] for e in observed if e['value']==3}
        for item in observed:
            if item['call']!=event['call'] or item['time']<entered['time']:return False
            if key in returns and item['time']>returns[key]['time']:return False
            if item['result'] not in (0x8000,0x1000) and not (item['result']==0 and item['file'] in eventfds):return False
        nonnetwork.append({'pid':event['pid'],'kernelPid':event['kernelPid'],'ordinal':event['ordinal'],
            'syscall':CALLS[event['call']-1],'fd':event['value'],
            'kernelReturn':(returns.get(key) or {}).get('result'),
            'fileKinds':sorted({'eventfd' if e['file'] in eventfds else 'regular' if e['result']==0x8000 else 'pipe' for e in bases}),
            'probes':sorted({FILE_WRITE_HOOKS[e['value']-1] for e in observed}),
            'reason':'actual_vfs_non_socket_write_without_socket_operation'})
        return True
    for pid, observed in pre.items():
        available = decoded[pid]
        for event in observed:
            key = (pid, event['ordinal'])
            if (not available or available[0][0:2]!=(event['call'],event['value'])) and non_socket_write(event):
                continue
            if not available:
                if (pid in terminal_pids and event is observed[-1] and event['ordinal']==tasks[pid].get('lastOrdinal')
                        and key not in calls and key not in returns and not any((hook['pid'],hook['ordinal'])==key for hook in hooks)):
                    task=tasks[pid]; not_executed[pid].append(event['ordinal'])
                    nonexecution.append(dict(pid=pid,kernelPid=task['kernelPid'],ordinal=event['ordinal'],
                        syscall=CALLS[event['call']-1],fd=event['value'],rangeStart=task['start'],rangeEnd=task['end'],
                        reason='final_pre_entry_without_kernel_execution'))
                    continue
                error('kernel_network_strace_entry_missing',pid,syscall=CALLS[event['call']-1],
                      fd=event['value'],ordinal=event['ordinal'],lastOrdinal=tasks[pid].get('lastOrdinal'),
                      kernelReturn=(returns.get(key) or {}).get('result'),
                      socketEvents=sum((hook['pid'],hook['ordinal'])==key for hook in hooks)); continue
            item = available.popleft()
            if item[0:2] != (event['call'],event['value']):
                error('kernel_network_invocation_mismatch', pid); continue
            if key not in calls:
                # Pre-entry exists, but ptrace/seccomp/user dispatch prevented
                # execution. Its interpreted result may be emulated, even 0.
                if item[2] is None:
                    if (pid not in terminal_pids or event is not observed[-1] or
                            event['ordinal']!=tasks[pid].get('lastOrdinal') or key in returns or
                            any((hook['pid'],hook['ordinal'])==key for hook in hooks)):
                        error('kernel_partial_call_execution_unproven',pid);continue
                    result_fields.append(dict(pid=pid,kernelPid=event['kernelPid'],sequence=item[3],
                        ordinal=event['ordinal'],syscall=CALLS[event['call']-1],fd=event['value'],
                        rangeStart=tasks[pid]['start'],rangeEnd=tasks[pid]['end'],
                        reason='final_known_call_not_executed'))
                matched.add(key); continue
            returned = returns.get(key)
            if returned is None:
                if item[2] is None and pid in terminal_pids and non_socket_write(event):
                    result_fields.append(dict(pid=pid,kernelPid=event['kernelPid'],sequence=item[3],
                        ordinal=event['ordinal'],syscall=CALLS[event['call']-1],fd=event['value'],
                        rangeStart=tasks[pid]['start'],rangeEnd=tasks[pid]['end'],
                        reason='known_call_actual_vfs_non_socket_write'))
                    matched.add(key);continue
                error('kernel_network_return_missing', pid); continue
            result=returned['result']
            if item[2] is None:
                result_fields.append(dict(pid=pid,kernelPid=event['kernelPid'],sequence=item[3],
                    ordinal=event['ordinal'],syscall=CALLS[event['call']-1],fd=event['value'],
                    rangeStart=tasks[pid]['start'],rangeEnd=tasks[pid]['end'],kernelReturn=result,
                    reason='known_call_result_from_raw_sys_exit'))
            elif (result if result >= 0 else -1) != item[2]:
                error('kernel_network_result_mismatch', pid); continue
            matched.add(key)
            matched_sequences[key]=item[3]
        if available:
            error('kernel_strace_pre_entry_missing', pid)
    for pid, available in decoded.items():
        if pid not in pre and available:
            error('kernel_strace_pre_entry_missing', pid)
    for event in hooks:
        key = (event['pid'], event['ordinal']); entry = calls.get(key)
        returned=returns.get(key)
        if (key in matched and entry and returned and entry['call'] == event['call'] and
                entry['time'] <= event['time'] <= returned['time']):
            if (event['result'] in (2,10) and known_destinations is not None and
                    (event['pid'],matched_sequences.get(key)) not in known_destinations):
                error('kernel_socket_destination_unparsed',event['pid'])
            continue
        # Attribute known ring workers conservatively to their owner. This
        # remains a failure; a pending ring is never proof that a hook was
        # caused by that request, and never discharges a register hole.
        owners = {ring['creatorPid'] for ring in (ring_evidence or {}).get('rings', [])
                  for submission in ring['submissions'] if submission['kernelPid'] == event['kernelPid']}
        task=mapping.get(event['kernelPid']); seen=set()
        while task and (task.get('ioWorker') or task.get('kernelThread')) and task['kernelPid'] not in seen:
            seen.add(task['kernelPid']); task=mapping.get(task.get('parentKernelPid'))
        if task and task['pid'] in states: owners.add(task['pid'])
        attributed = event['pid'] if event['pid'] in states else next(iter(owners)) if len(owners)==1 else None
        error('kernel_socket_operation_strace_missing', attributed,
              hook=SOCKET_HOOKS[event['value']-1] if 1<=event['value']<=len(SOCKET_HOOKS) else 'invalid',
              familySource='socket',
              ordinal=event['ordinal'],kernelCall=event['call'],nativeSyscall=event.get('nativeSyscall'),family=event['result'],
              time=event['time'],entryTime=entry['time'] if entry else None,
              returnTime=returned['time'] if returned else None)
    metadata=[]
    if not issues:
        for pid, count in holes.items():
            task = tasks[pid]
            resolved.append(dict(pid=pid, kernelPid=task['kernelPid'], records=count,
                rangeStart=task['start'], rangeEnd=task['end'],
                networkEntries=len(entries[pid]), socketEvents=sum(e['pid']==pid for e in hooks),
                preEntryInvocations=len(pre[pid]), notExecutedOrdinals=not_executed[pid],
                reason='complete_task_lifetime_no_unmatched_kernel_network_activity'))
        for pid,sequence,fd in close_fields:
            if pid not in terminal_pids:continue
            task=tasks[pid]
            metadata.append(dict(pid=pid,kernelPid=task['kernelPid'],sequence=sequence,syscall='close',fd=fd,
                records=1,rangeStart=task['start'],rangeEnd=task['end'],
                networkEntries=len(entries[pid]),socketEvents=sum(e['pid']==pid for e in hooks),
                returnValueKnown=False,fdClosureInferred=False,
                reason='known_close_missing_return_no_unmatched_kernel_network_activity'))
    return dict(issues=issues, resolved=resolved, notExecuted=nonexecution if not issues else [],
                nonNetworkWrites=nonnetwork if not issues else [],resultFields=result_fields if not issues else [],
                metadataFields=metadata,eventCount=len(events))
