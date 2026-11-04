"""Generate the kernel recorder: metadata only, never buffers/argv."""
from uring.network import program as network_program


def program(root_pid, namespace_inode, numbers_offset, submit, pre_entry=None):
    normalize='''
  $t=(struct task_struct*)curtask;
  $level=$t->thread_pid->level;
  $nspid=0; $nstgid=0;
  if ($level >= @audit_level) {
    $up=(struct upid*)((uint64)$t->thread_pid+OFFSET+@audit_level*sizeof(struct upid));
    $leader=(struct task_struct*)$t->group_leader;
    $gp=(struct upid*)((uint64)$leader->thread_pid+OFFSET+@audit_level*sizeof(struct upid));
    if ($up->ns->ns.inum==NAMESPACE && $gp->ns->ns.inum==NAMESPACE) {
      $nspid=$up->nr; $nstgid=$gp->nr;
    } else { @namespace_error=count(); }
  }
'''
    source='''
BEGIN { printf("READY\\n"); }
tracepoint:sched:sched_process_exec {
  $t=(struct task_struct*)curtask;
  $level=$t->thread_pid->level;
  $up=(struct upid*)((uint64)$t->thread_pid+OFFSET+$level*sizeof(struct upid));
  if ((uint32)$up->nr==ROOT_PID && $up->ns->ns.inum==NAMESPACE && !@root_seen) {
    @audit_level=$level; @audit_root_tid=tid; @root_seen=1; @tracked[tid]=1; @root_count=count(); @born_count=count();
    @birth[tid]=nsecs;
    printf("ROOT|%llu|%d|%d|%d|%u\\n",nsecs,pid,tid,$up->nr,$level);
  }
}
tracepoint:sched:sched_process_fork /@tracked[args->parent_pid]/ {
  @tracked[args->child_pid]=1;
  @birth[args->child_pid]=nsecs;
  @kernel_parent[args->child_pid]=args->parent_pid;
  @born_count=count();
}
kprobe:create_io_thread /@tracked[tid]/ {
  @worker_enter=count();
  if (@io_birth[tid]) { @worker_error=count(); }
  @io_birth[tid]=nsecs;
}
kretprobe:create_io_thread /@tracked[tid]/ {
  @worker_return=count();
  if (!@io_birth[tid]) { @worker_error=count(); }
  else {
  if ((uint64)retval && (uint64)retval < (uint64)0xfffffffffffff001) {
    $child=(struct task_struct*)retval;
    $child_pid=$child->pid;
    if ($child_pid<=0 || ($child->flags & 0x4010)!=0x4010) { @worker_error=count(); }
    else {
      if (!@tracked[$child_pid]) {
        @tracked[$child_pid]=1; @birth[$child_pid]=@io_birth[tid];
        @kernel_parent[$child_pid]=tid; @born_count=count();
      }
      @worker_count=count();
      printf("W|%llu|%d|%d|%u|%llu\\n",nsecs,$child_pid,tid,$child->flags,@birth[$child_pid]);
    }
  }
  delete(@io_birth[tid]);
  }
}
tracepoint:sched:sched_process_exit /@tracked[tid]/ {
NORMALIZE
  @task_count=count();
  printf("T|%llu|%d|%d|%d|%d|%llu|%d|%u|%llu\\n",nsecs,pid,tid,$nspid,$nstgid,@birth[tid],@kernel_parent[tid],$t->flags,@pre_seq[tid]);
  @dead_count=count(); delete(@tracked[tid]); delete(@birth[tid]);
  if (@kernel_parent[tid]) { delete(@kernel_parent[tid]); }
  if (@net_seq[tid]) { delete(@net_seq[tid]); }
  if (@net_call[tid]) { delete(@net_call[tid]); delete(@net_fd[tid]); }
  if (@pre_seq[tid]) { delete(@pre_seq[tid]); delete(@pre_call[tid]); }
  if (@raw_active[tid]) { delete(@raw_active[tid]); delete(@raw_id[tid]); }
}
tracepoint:io_uring:io_uring_create {
  if (@tracked[tid] || @tracked[pid]) {
NORMALIZE
  $ctx=(uint64)args->ctx;
  @owned[$ctx]=1; @flags[$ctx]=args->flags;
  $sqpid=0;
  if (args->flags&2) {
    $ring=(struct io_ring_ctx*)args->ctx;
    $sqpid=$ring->sq_data->thread->pid;
    if ($sqpid>0) {
      if (!@tracked[$sqpid]) { @untracked_sqpoll=count(); }
    } else { @untracked_sqpoll=count(); }
  }
  @create_count=count();
  printf("C|%llu|%llu|%d|%d|%d|%d|%d|%u|%d\\n",nsecs,$ctx,pid,tid,$nspid,$nstgid,args->fd,args->flags,$sqpid);
  } else if (@owned[(uint64)args->ctx]) {
    @retire_count=count();
    printf("R|%llu|%llu\\n",nsecs,(uint64)args->ctx);
    delete(@owned[(uint64)args->ctx]); delete(@flags[(uint64)args->ctx]);
  }
}
tracepoint:io_uring:SUBMIT /@owned[(uint64)args->ctx] || @tracked[tid] || @tracked[pid]/ {
NORMALIZE
  @submit_count=count();
  if (!@pending[(uint64)args->ctx,(uint64)args->req]) { @pending[(uint64)args->ctx,(uint64)args->req]=1; @started_req=count(); }
  if (args->sq_thread && !@tracked[tid]) { @untracked_sqpoll=count(); }
  printf("S|%llu|%llu|%d|%d|%d|%d|%u|%u\\n",nsecs,(uint64)args->ctx,pid,tid,$nspid,$nstgid,args->opcode,args->sq_thread);
}
tracepoint:io_uring:io_uring_req_failed /@owned[(uint64)args->ctx] || @tracked[tid] || @tracked[pid]/ {
NORMALIZE
  @failed_count=count();
  if (!@pending[(uint64)args->ctx,(uint64)args->req]) { @pending[(uint64)args->ctx,(uint64)args->req]=1; @started_req=count(); }
  printf("F|%llu|%llu|%d|%d|%d|%d|%u|%u\\n",nsecs,(uint64)args->ctx,pid,tid,$nspid,$nstgid,args->opcode,(@flags[(uint64)args->ctx]&2)!=0);
}
tracepoint:io_uring:io_uring_complete /@owned[(uint64)args->ctx]/ {
  @complete_count=count();
  if (@pending[(uint64)args->ctx,(uint64)args->req]) {
    delete(@pending[(uint64)args->ctx,(uint64)args->req]); @completed_req=count();
  } else { @unmatched_completion=count(); }
  printf("K|%llu|%llu\\n",nsecs,(uint64)args->ctx);
}
interval:ms:250 {
  @state_count=count();
  printf("TICK|%llu\\n",nsecs);
  print(@born_count); print(@dead_count); print(@started_req); print(@completed_req);
  printf("TICKEND\\n");
}
END {
  printf("DONE\\n");
  clear(@tracked); clear(@owned); clear(@flags); clear(@root_seen); clear(@audit_level); clear(@pending);
  clear(@birth); clear(@net_seq); clear(@net_call); clear(@net_fd); clear(@audit_root_tid);
  clear(@kernel_parent); clear(@pre_seq); clear(@pre_call);
  clear(@io_birth); clear(@raw_active); clear(@raw_id);
}
'''
    source += network_program(normalize,pre_entry)
    return source.replace('NORMALIZE',normalize).replace('OFFSET',str(numbers_offset)).replace(
        'NAMESPACE',str(namespace_inode)).replace('ROOT_PID',str(root_pid)).replace('SUBMIT /',submit+' /')
