"""UDP object recorder, independent of descriptor tables and register decoding.

All attachments are mandatory. sk_alloc establishes a fresh allocation before
the protocol init callback; __sk_destruct's return proves the final free ran,
including asynchronous RCU destruction outside the audited task lineage.
"""

ARGUMENTS = {'sk_alloc': 'net', 'udp_init_sock': 'sock', 'udpv6_init_sock': 'sock',
             'inet_dgram_connect': 'socket', 'udp_sendmsg': 'sock', 'udpv6_sendmsg': 'sock',
             '__sock_release': 'socket', '__sk_destruct': 'callback_head',
             'receive_fd': 'file', 'receive_fd_replace': '=s32', 'ip_local_out': 'net', 'ip6_local_out': 'net',
             'ip_send_skb':'net','ip6_send_skb':'sk_buff'}

CLEANUP = '''
  clear(@udp_alloc_pending); clear(@udp_allocation); clear(@udp_generation); clear(@udp_family);
  clear(@udp_destruct_depth); clear(@udp_destruct_gen); clear(@udp_destruct_family);
  clear(@udp_socket_ready);
'''


def definitions():
    fields={'udp_init_sock':{'arg0':'sk'},'udpv6_init_sock':{'arg0':'sk'},
            'inet_dgram_connect':{'arg0':'sock'},'udp_sendmsg':{'arg0':'sk'},
            'udpv6_sendmsg':{'arg0':'sk'},'__sock_release':{'arg0':'sock'},
            '__sk_destruct':{'arg0':'head'},'receive_fd':{'arg0':'file'},
            'receive_fd_replace':{'arg1':'file'},'ip_local_out':{'arg1':'sk'},'ip6_local_out':{'arg1':'sk'},
            'ip_send_skb':{'arg1':'skb'},'ip6_send_skb':{'arg0':'skb'}}
    specs={name+'_e':{'symbol':name,'return':False,'fields':fields.get(name,{})} for name in ARGUMENTS}
    specs.update(sk_alloc_r={'symbol':'sk_alloc','return':True,'fields':{}},
                 __sk_destruct_r={'symbol':'__sk_destruct','return':True,'fields':{'arg0':'head'}},
                 do_task_dead_e={'symbol':'do_task_dead','return':False,'fields':{}})
    return specs


def trampoline_source(source, specs):
    """Use public BTF fentry/fexit; no kretprobe instance pool can lose returns."""
    import re
    matches=list(re.finditer(r'(?m)^(kprobe|kretprobe):([A-Za-z0-9_]+)',source))
    parts=[];last=0
    for index,match in enumerate(matches):
        end=matches[index+1].start() if index+1<len(matches) else len(source)
        parts.append(source[last:match.start()])
        mode,symbol=match[1],match[2];spec=specs[symbol+('_r' if mode=='kretprobe' else '_e')]
        block=source[match.end():end]
        for raw,field in spec['fields'].items():block=re.sub(r'\b'+raw+r'\b','args->'+field,block)
        if re.search(r'\barg[01]\b',block):raise RuntimeError('kernel_udp_typed_argument_missing')
        parts.append(('kretfunc:' if spec['return'] else 'kfunc:')+symbol+block);last=end
    parts.append(source[last:])
    return ''.join(parts)


def requirements(available):
    missing = set(ARGUMENTS) - available
    if missing:
        raise RuntimeError('kernel_udp_object_probe_missing_' + '_'.join(sorted(missing)))
    from uring.entry import btf_signature
    signatures = {name: btf_signature(name, first_parameter=kind[1:] if kind.startswith('=') else 'ptr:struct:' + kind)
                  for name, kind in ARGUMENTS.items()}
    if signatures['sk_alloc'] != {'parameters': ['ptr:struct:net', 's32', 'u32', 'ptr:struct:proto', 's32'],
                                  'return': 'ptr:struct:sock'}:
        raise RuntimeError('kernel_udp_allocation_signature_unsupported')
    if signatures['__sk_destruct'] != {'parameters': ['ptr:struct:callback_head'], 'return': 'void'}:
        raise RuntimeError('kernel_udp_destructor_signature_unsupported')
    if signatures['receive_fd_replace'] != {'parameters': ['s32', 'ptr:struct:file', 'u32'], 'return': 's32'}:
        raise RuntimeError('kernel_udp_import_signature_unsupported')
    for name in ('ip_local_out','ip6_local_out'):
        if signatures[name] != {'parameters': ['ptr:struct:net','ptr:struct:sock','ptr:struct:sk_buff'], 'return': 's32'}:
            raise RuntimeError('kernel_udp_output_signature_unsupported')
    for name,parameters in [('ip_send_skb',['ptr:struct:net','ptr:struct:sk_buff']),
                            ('ip6_send_skb',['ptr:struct:sk_buff'])]:
        if signatures[name]!={'parameters':parameters,'return':'s32'}:
            raise RuntimeError('kernel_udp_skb_output_signature_unsupported')
    return signatures


def program(normalize, rcu_offset):
    source = r'''
kprobe:sk_alloc /tid != @audit_root_tid && @tracked[tid]/ {
  @udp_alloc_enter=count();
  if (@udp_alloc_pending[tid]) { @udp_object_error=count(); }
  @udp_alloc_pending[tid]=1;
}
kretprobe:sk_alloc /@udp_alloc_pending[tid]/ {
  @udp_alloc_return=count(); delete(@udp_alloc_pending[tid]);
  if ((uint64)retval && (uint64)retval < (uint64)0xfffffffffffff001) {
    $sk=(struct sock*)retval; $key=(uint64)$sk;
    if ($sk->__sk_common.skc_family==2 || $sk->__sk_common.skc_family==10) {
      if (@udp_allocation[$key]) { @udp_object_error=count(); }
      @udp_allocation[$key]=nsecs;
    }
  }
}
'''
    for hook in ('udp_init_sock', 'udpv6_init_sock'):
        source += r'''
kprobe:HOOK /tid != @audit_root_tid && @tracked[tid]/ {
NORMALIZE
  $sk=(struct sock*)arg0; $key=(uint64)$sk;
  $generation=@udp_allocation[$key]; $family=$sk->__sk_common.skc_family;
  if (!$generation || @udp_generation[$key] || $sk->sk_type!=2 || $sk->sk_protocol!=17 ||
      ($family!=2 && $family!=10)) { @udp_object_error=count(); }
  @udp_generation[$key]=$generation; @udp_family[$key]=$family; @udp_born=count();
  @udp_object_count=count();
  printf("O|B|%llu|%llu|%llu|%d|%d|%d|%d|%llu|%d|%d|%d|0\n",
    nsecs,$key,$generation,pid,tid,$nspid,$nstgid,@net_seq[tid],@net_call[tid],@net_fd[tid],$family);
}
'''.replace('HOOK', hook)
    for hook, kind, argument, number in [('inet_dgram_connect', 'C', 'socket', 1),
                                         ('udp_sendmsg', 'S', 'sock', 2),
                                         ('udpv6_sendmsg', 'S', 'sock', 3),
                                         ('__sock_release', 'U', 'socket', 4),
                                         ('receive_fd', 'U', 'file', 5),
                                         ('receive_fd_replace', 'U', 'file2', 6),
                                         ('ip_local_out', 'L', 'output', 7),
                                         ('ip6_local_out', 'L', 'output', 8),
                                         ('ip_send_skb', 'L', 'skb1', 9),
                                         ('ip6_send_skb', 'L', 'skb0', 10)]:
        argument_source = ('$sock=(struct socket*)arg0; $sk=$sock->sk;' if argument == 'socket' else
            '$file=(struct file*)arg0; $sk=(struct sock*)0; if (!(($file->f_mode) & (1 << 14)) && '
            '($file->f_inode->i_mode & 0xf000)==0xc000) '
            '{ $sock=(struct socket*)$file->private_data; $sk=$sock->sk; }' if argument in ('file','file2') else
            '$sk=(struct sock*)arg1;' if argument == 'output' else
            '$skb=(struct sk_buff*)arg1; $sk=$skb->sk;' if argument=='skb1' else
            '$skb=(struct sk_buff*)arg0; $sk=$skb->sk;' if argument=='skb0' else '$sk=(struct sock*)arg0;')
        if argument == 'file2': argument_source=argument_source.replace('arg0','arg1')
        source += r'''
kprobe:HOOK {
  SOCK
  $key=(uint64)$sk;
  if ($key && (@udp_generation[$key] || (tid != @audit_root_tid && @tracked[tid] &&
       $sk->sk_type==2 && $sk->sk_protocol==17 &&
       ($sk->__sk_common.skc_family==2 || $sk->__sk_common.skc_family==10)))) {
NORMALIZE
    @udp_object_count=count();
    printf("O|KIND|%llu|%llu|%llu|%d|%d|%d|%d|%llu|%d|%d|%d|NUMBER\n",
      nsecs,$key,@udp_generation[$key],pid,tid,$nspid,$nstgid,@net_seq[tid],@net_call[tid],
      @net_fd[tid],$sk->__sk_common.skc_family);
  }
}
'''.replace('HOOK', hook).replace('KIND', kind).replace('NUMBER', str(number)).replace(
            'SOCK', argument_source)
    # fexit retains the original head pointer value without reading freed
    # memory. Track frames only for a watched UDP address (including nested
    # reuse while an older generation is pending), not unrelated TCP frees.
    source += r'''
kprobe:__sk_destruct /@udp_socket_ready/ {
  $who=(int64)tid; if (!tid) { $who=-1-(int64)cpu; }
  $sk=(struct sock*)((uint64)arg0 - SOCK_RCU_OFFSET); $key=(uint64)$sk;
  if (@udp_allocation[$key]) {
    delete(@udp_allocation[$key]);
  }
  if (@udp_generation[$key] || @udp_destruct_depth[$who,$key]) {
    $depth=@udp_destruct_depth[$who,$key]+1; @udp_destruct_depth[$who,$key]=$depth;
    @udp_stack_enter=count();
    if (@udp_generation[$key]) {
      $generation=@udp_generation[$key]; $family=@udp_family[$key];
      @udp_destruct_gen[$who,$key,$depth]=$generation;
      @udp_destruct_family[$who,$key,$depth]=$family; @udp_destruct_enter=count();
      @udp_object_count=count();
      printf("O|Q|%llu|%llu|%llu|0|0|0|0|0|0|0|%d|0\n",nsecs,$key,$generation,$family);
      delete(@udp_generation[$key]); delete(@udp_family[$key]);
    }
  }
}
kretprobe:__sk_destruct /@udp_socket_ready/ {
  $who=(int64)tid; if (!tid) { $who=-1-(int64)cpu; }
  $key=(uint64)arg0 - SOCK_RCU_OFFSET;
  $depth=@udp_destruct_depth[$who,$key];
  if ($depth) {
    @udp_stack_return=count();
    if (@udp_destruct_gen[$who,$key,$depth]) {
      @udp_destruct_return=count(); @udp_freed=count(); @udp_object_count=count();
      printf("O|F|%llu|%llu|%llu|0|0|0|0|0|0|0|%d|0\n",nsecs,$key,
        @udp_destruct_gen[$who,$key,$depth],@udp_destruct_family[$who,$key,$depth]);
      delete(@udp_destruct_gen[$who,$key,$depth]);
      delete(@udp_destruct_family[$who,$key,$depth]);
    }
    if ($depth==1) { delete(@udp_destruct_depth[$who,$key]); }
    else { @udp_destruct_depth[$who,$key]=$depth-1; }
  }
}
'''
    if not isinstance(rcu_offset, int) or rcu_offset < 0:
        raise RuntimeError('kernel_udp_rcu_layout_missing')
    return source.replace('NORMALIZE', normalize).replace('SOCK_RCU_OFFSET', str(rcu_offset))


def parse(fields):
    if len(fields) != 14 or fields[1] not in ('B', 'C', 'S', 'L', 'U', 'Q', 'F'):
        raise ValueError('invalid_kernel_udp_object_record')
    names = ('time', 'socket', 'generation', 'kernelTgid', 'kernelPid', 'pid', 'tgid',
             'ordinal', 'call', 'fd', 'family', 'hook')
    return dict(kind=fields[1], **dict(zip(names, map(int, fields[2:]))))
