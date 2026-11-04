"""Reconcile io_uring kernel submissions with strace setup and process ownership.

The allowlist is the explicit operation enum and submission sites in Node
v24.11.0 deps/uv/src/unix/linux.c. No observed operation is auto-allowed.
"""
from collections import Counter, defaultdict, deque
import hashlib

# https://github.com/nodejs/node/blob/v24.11.0/deps/uv/src/unix/linux.c#L138-L151
ALLOWED_OPCODES = {1:'READV',2:'WRITEV',3:'FSYNC',18:'OPENAT',19:'CLOSE',21:'STATX',
                   29:'EPOLL_CTL',35:'RENAMEAT',36:'UNLINKAT',37:'MKDIRAT',38:'SYMLINKAT',
                   39:'LINKAT',55:'FTRUNCATE'}
NETWORK_OPCODES = {9:'SENDMSG',10:'RECVMSG',13:'ACCEPT',16:'CONNECT',26:'SEND',27:'RECV',
                   34:'SHUTDOWN',45:'SOCKET',47:'SEND_ZC',48:'SENDMSG_ZC'}


def reconcile(capture, calls, all_pids, selected_pids):
    """Unknown collection/identity is global; known outside operations are report-only."""
    global_issues=[];by_pid=defaultdict(list);rings={};records=[]
    totals=Counter();selected_totals=Counter()
    def global_error(reason,pid=None):
        issue={'reason':reason}
        if pid is not None:issue['pid']=pid
        global_issues.append(issue)
    if (capture.get('status')!='captured' or not capture.get('complete')
            or capture.get('lostEvents')!=0 or not capture.get('pidNamespaceVerified')):
        global_error('io_uring_kernel_capture_incomplete')
        return {'globalIssues':global_issues,'issuesByPid':{},'rings':[],'opcodeCounts':{},'selectedOpcodeCounts':{}}
    setups=defaultdict(deque)
    for call in calls:
        if call['call']=='io_uring_setup' and isinstance(call.get('result'),int) and call['result']>=0:
            setups[(call['pid'],call['result'])].append(call)
        elif call['call']=='io_uring_setup' and call.get('result') is None:
            global_error('io_uring_setup_result_unknown',call['pid'])
    events=capture.get('events',[])
    if capture.get('eventCount')!=len(events):global_error('io_uring_event_count_mismatch')
    setup_rings={}
    for event in sorted(events,key=lambda e:e.get('time',-1)):
        stamp=event.get('time');ctx=event.get('ctx');pid=event.get('pid');kind=event.get('kind')
        if not isinstance(stamp,int) or stamp<0 or not ctx:
            global_error('io_uring_event_invalid');continue
        if kind=='retire':
            rings.pop(ctx,None);continue
        if kind=='complete':continue
        if kind=='create':
            if pid not in all_pids or not isinstance(event.get('tgid'),int):
                global_error('io_uring_creator_unattributed',pid);continue
            key=(pid,event.get('fd'));pending=setups[key]
            if not pending:
                global_error('io_uring_create_strace_mismatch',pid);continue
            call=pending.popleft()
            if event.get('flags')!=call.get('flags') or event.get('tgid')!=call.get('tgid'):
                global_issues.append({'reason':'io_uring_create_identity_mismatch','pid':pid,
                    'straceFlags':call.get('flags'),'kernelFlags':event.get('flags'),
                    'straceTgid':call.get('tgid'),'kernelTgid':event.get('tgid')});continue
            record={'ringId':len(records)+1,'creatorPid':pid,'creatorTgid':event['tgid'],
                    'contextId':'ctx-'+hashlib.sha256(f"{capture.get('namespaceInode')}:{ctx}:{stamp}".encode()).hexdigest()[:24],
                    'creatorKernelPid':event.get('kernelPid'),'creatorKernelTgid':event.get('kernelTgid'),
                    'sqpollKernelPid':event.get('sqpollKernelPid',0),
                    'fd':event['fd'],'flags':event['flags'],'createdAt':stamp,'opcodeCounts':{},'submissions':[]}
            records.append(record);rings[ctx]=record
            if event['flags'] & ~(2|65536):
                by_pid[pid].append({'reason':'io_uring_setup_mode_unsupported','pid':pid,'ringId':record['ringId']})
            setup_rings[(call['pid'],call.get('sequence'),event['fd'])]=record
        elif kind in ('submit','failed'):
            ring=rings.get(ctx)
            if ring is None or stamp<ring['createdAt']:
                global_error('io_uring_operation_ring_unattributed',pid);continue
            sqpoll=event.get('sqpoll')
            if not isinstance(sqpoll,bool) or sqpoll!=bool(ring['flags']&2):
                global_error('io_uring_sqpoll_flags_mismatch',pid);continue
            if sqpoll and (not ring['sqpollKernelPid'] or event.get('kernelPid')!=ring['sqpollKernelPid']):
                global_error('io_uring_sqpoll_task_mismatch',pid);continue
            if pid not in all_pids and not sqpoll:
                global_error('io_uring_submitter_unattributed',pid);continue
            owner=ring['creatorPid']
            attributed=owner if sqpoll else pid
            opcode=event.get('opcode')
            label=ALLOWED_OPCODES.get(opcode) or NETWORK_OPCODES.get(opcode) or f'UNKNOWN_{opcode}'
            totals[label]+=1
            if owner in selected_pids or attributed in selected_pids:selected_totals[label]+=1
            ring['opcodeCounts'][label]=ring['opcodeCounts'].get(label,0)+1
            ring['submissions'].append({'pid':pid,'tgid':event.get('tgid'),'kernelPid':event.get('kernelPid'),
                'kernelTgid':event.get('kernelTgid'),'attributedPid':attributed,'opcode':opcode,'operation':label,
                'sqpoll':sqpoll,'failedBeforeSubmission':kind=='failed'})
            if opcode not in ALLOWED_OPCODES:
                by_pid[owner if owner in selected_pids else attributed].append({
                    'reason':'io_uring_opcode_not_allowed','pid':attributed,'opcode':opcode,'operation':label,
                    'ringId':ring['ringId']})
        else:
            global_error('io_uring_event_kind_unknown',pid)
    for (pid,fd),pending in setups.items():
        if pending:global_error('io_uring_strace_ring_missing',pid)
    # Track only ring descriptors. Kernel setup descriptors are CLOEXEC; dup,
    # fork/shared tables, close and exec must not turn an inherited ring into a
    # silently unobserved channel. Unknown/imported descriptors fail closed.
    tables={}
    for call in sorted(calls,key=lambda c:c.get('sequence',0)):
        group=call['pid'];table=tables.setdefault(group,{})
        kind=call['call'];fd=call.get('fd');result=call.get('result')
        if kind=='fork':
            child=call.get('child',call.get('childTgid'))
            if child!=group:tables[child]=table if call.get('shareFiles') else dict(table)
            continue
        if kind=='exec':
            tables[group]={f:record for f,record in table.items() if not record[1]}
            continue
        if kind=='io_uring_setup':
            if isinstance(result,int) and result>=0:
                ring=setup_rings.get((call['pid'],call.get('sequence'),result))
                if ring is not None:table[result]=(ring,True)
            continue
        if result is None:
            by_pid[call['pid']].append({'reason':'io_uring_descriptor_result_unknown','pid':call['pid']});continue
        if kind=='close_range' and result==0:
            if call.get('unshare'):
                table=dict(table);tables[group]=table
            last=call.get('lastFd')
            if isinstance(fd,int) and isinstance(last,int):
                for number in list(table):
                    if fd<=number<=last:
                        if call.get('cloexec'):table[number]=(table[number][0],True)
                        else:table.pop(number)
            continue
        if kind=='close' and result==0:
            table.pop(fd,None);continue
        if call.get('duplicate') and isinstance(result,int) and result>=0:
            if fd in table:table[result]=(table[fd][0],call.get('cloexec',False))
            else:table.pop(result,None)
            continue
        if call.get('setfd') and result==0 and fd in table:
            table[fd]=(table[fd][0],call.get('cloexec',False));continue
        if kind not in ('io_uring_enter','io_uring_register','mmap','mmap2'):continue
        if isinstance(result,int) and result<0 and (kind in ('mmap','mmap2') or call.get('error')=='EBADF'):continue
        if call.get('registeredRing'):
            by_pid[call['pid']].append({'reason':'io_uring_registered_ring_mode_unsupported','pid':call['pid']});continue
        if fd not in table:
            by_pid[call['pid']].append({'reason':'io_uring_descriptor_unattributed','pid':call['pid']});continue
        ring=table[fd][0]
        if kind in ('mmap','mmap2') and call['pid']!=ring['creatorPid']:
            by_pid[call['pid']].append({'reason':'io_uring_borrowed_ring_mapping_unsupported','pid':call['pid'],'ringId':ring['ringId']})
        if kind=='io_uring_enter' and isinstance(result,int) and result>0:
            ring['straceSubmitted']=ring.get('straceSubmitted',0)+result
        if call['pid'] in selected_pids and ring['creatorPid'] not in selected_pids:
            by_pid[call['pid']].append({'reason':'io_uring_cross_scope_ring','pid':call['pid'],'ringId':ring['ringId']})
    for ring in records:
        if ring.get('straceSubmitted',0)>len(ring['submissions']):
            global_error('io_uring_kernel_submissions_missing',ring['creatorPid'])
    return {'globalIssues':global_issues,'issuesByPid':dict(by_pid),'rings':records,
            'opcodeCounts':dict(totals),'selectedOpcodeCounts':dict(selected_totals)}
