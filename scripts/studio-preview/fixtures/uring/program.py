"""Generate the kernel recorder: process IDs/ctx/opcode only, never buffers/argv."""


def program(root_pid, namespace_inode, numbers_offset, submit):
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
    @audit_level=$level; @root_seen=1; @tracked[tid]=1; @root_count=count(); @born_count=count();
    printf("ROOT|%llu|%d|%d|%d|%u\\n",nsecs,pid,tid,$up->nr,$level);
  }
}
tracepoint:sched:sched_process_fork /@tracked[args->parent_pid]/ {
  @tracked[args->child_pid]=1;
  @born_count=count();
}
tracepoint:sched:sched_process_exit /@tracked[tid]/ { @dead_count=count(); delete(@tracked[tid]); }
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
      if (!@tracked[$sqpid]) { @tracked[$sqpid]=1; @born_count=count(); }
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
}
'''
    return source.replace('NORMALIZE',normalize).replace('OFFSET',str(numbers_offset)).replace(
        'NAMESPACE',str(namespace_inode)).replace('ROOT_PID',str(root_pid)).replace('SUBMIT /',submit+' /')
