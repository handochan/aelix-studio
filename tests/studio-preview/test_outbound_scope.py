"""Scoped syscall audit: lineage, attribution, fail-closed parsing and real children."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/studio-preview/fixtures/outboundAudit.py'
spec = importlib.util.spec_from_file_location('scoped_outbound_audit', SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

HOST = '/owned/aelix-studio-host'
PYTHON = '/owned/native/python3'
CONNECT = 'connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.1")}, 16) = -1 ENETUNREACH (Network unreachable)'
LOCAL = CONNECT.replace('203.0.113.1', '127.0.0.1')


class CaptureStartupFailureTests(unittest.TestCase):
    def test_start_failure_is_preserved_even_when_broker_evidence_is_unavailable(self):
        for broker_error in (False,True):
            with self.subTest(broker_error=broker_error), tempfile.TemporaryDirectory() as directory:
                capture=Mock()
                capture.start.side_effect=RuntimeError('kernel_tracepoint_unavailable')
                if broker_error:capture.stop.side_effect=OSError('missing broker result')
                else:capture.stop.return_value={'status':'failed','complete':False,'lostEvents':0,
                    'pidNamespaceVerified':False,'events':[],'eventCount':0,'reason':'kernel_recorder_sudo_required'}
                process=Mock(pid=123,returncode=0);process.poll.return_value=0
                report=Path(directory)/'report.json'
                with patch.dict(os.environ,{},clear=True), patch.object(audit.sys,'platform','linux'), \
                     patch.object(audit.shutil,'which',return_value='/usr/bin/strace'), \
                     patch.object(audit,'npm_config_paths',return_value=[]), \
                     patch.object(audit,'npm_proxy_configured',return_value=False), \
                     patch.object(audit,'Capture',return_value=capture), \
                     patch.object(audit.subprocess,'Popen',return_value=process):
                    code=audit.audit(['/owned/command'],report)
                evidence=json.loads(report.read_text())['ioUring']['capture']
                self.assertEqual(code,87)
                self.assertEqual(evidence['reason'],'kernel_tracepoint_unavailable')
                self.assertIn({'reason':'kernel_tracepoint_unavailable'},evidence['recordErrors'])


class ScopedParserTests(unittest.TestCase):
    def test_kernel_corroboration_discharges_only_exact_terminal_register_holes(self):
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,
                 'eventCount':0,'events':[],'network':{'complete':True,'eventCount':0,'events':[],
                 'tasks':[{'pid':pid,'tgid':pid,'kernelPid':pid+100,'kernelTgid':pid+100,'start':1,'end':100,'lastOrdinal':10,
                           'parentKernelPid':1000 if pid==1 else 101} for pid in (1,2)]}}
        capture['root']={'kernelPid':1000,'pid':1000}
        capture['network']['tasks'].append({'pid':1000,'tgid':1000,'kernelPid':1000,'kernelTgid':1000,'start':1,'end':100,'lastOrdinal':0})
        for hidden_network in (False,True):
            with self.subTest(hidden_network=hidden_network),tempfile.TemporaryDirectory() as directory:
                trace=Path(directory)/'trace'
                trace.write_text('\n'.join(self.base()+['2<host> ???( <unfinished ...>',
                    '2<host> <... ??? resumed>) = ?', '2<host> +++ killed by SIGKILL +++',
                    '1<app> +++ exited with 0 +++'])+'\n')
                if hidden_network:
                    capture['network']['events']=[{'kind':'H','time':10,'pid':2,'tgid':2,
                        'kernelPid':102,'kernelTgid':102,'call':0,'ordinal':0,'value':7,'result':10}]
                    capture['network']['eventCount']=1
                scoped,whole=audit.analyze_processes([trace],(HOST,),(HOST,),True,capture)
                self.assertEqual(scoped['kernelResolvedRecords'],0 if hidden_network else 2)
                self.assertEqual(whole['kernelResolvedRecords'],scoped['kernelResolvedRecords'])
                self.assertEqual(scoped['unparsedRecords']>0,hidden_network)

    def parse(self, lines, roots=(HOST, PYTHON), required=(HOST,), lifecycle=False):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'network.trace'
            trace.write_text('\n'.join(lines) + '\n')
            return audit.analyze_processes([trace], roots, required, lifecycle)

    def base(self):
        return ['1<app> execve("/owned/app", [...], 0x1 /* 1 var */) = 0',
                '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 2<host>',
                f'2<host> execve("{HOST}", [...], 0x1 /* 1 var */) = 0']

    def test_only_selected_roots_and_descendants_are_enforced(self):
        scoped, whole = self.parse(self.base() + [
            f'2<host> {LOCAL}',
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>',
            '3<renderer> execve("/owned/renderer", [...], 0x1 /* 1 var */) = 0',
            f'3<renderer> {CONNECT}',
            '3<renderer> connect(4, <unfinished ...>'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (0, 0))
        self.assertEqual((whole['externalAttempts'], whole['unparsedRecords']), (1, 1))
        self.assertFalse(next(p for p in whole['processes'] if p['pid'] == 3)['inScope'])

    def test_reexec_renamed_reparented_child_stays_in_scope(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=CLONE_PARENT|SIGCHLD) = 3<native>',
            '3<native> execve("/owned/other-program", [...], 0x1 /* 1 var */) = 0',
            '3<renamed> clone(child_stack=NULL, flags=CLONE_THREAD) = 4<worker>',
            f'4<worker> {CONNECT}'])
        self.assertEqual(scoped['externalAttempts'], 1)
        self.assertEqual(scoped['external'][0]['pid'], 4)
        self.assertEqual(scoped['unparsedRecords'], 0)

    def test_independent_native_helper_is_an_additional_root(self):
        scoped, _ = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<native>',
            f'3<native> execve("{PYTHON}", [...], 0x1 /* 1 var */) = 0',
            f'3<native> {CONNECT}'])
        self.assertEqual(scoped['rootPids'], [2, 3])
        self.assertEqual(scoped['externalAttempts'], 1)

    def test_same_comm_or_basename_is_not_a_root(self):
        scoped, whole = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<host>',
            '3<host> execve("/unselected/aelix-studio-host", [...], 0x1 /* 1 var */) = 0',
            f'3<host> {CONNECT}'])
        self.assertEqual(scoped['externalAttempts'], 0)
        self.assertEqual(whole['externalAttempts'], 1)

    def test_missing_root_fork_edge_or_unknown_exec_fails_closed(self):
        for lines in [self.base()[:1], self.base() + [f'3<orphan> {CONNECT}'],
                      self.base() + ['2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<native>',
                                     '3<native> execve("./unknown", [...], 0x1 /* 1 var */) = 0']]:
            with self.subTest(lines=lines):
                scoped, _ = self.parse(lines)
                self.assertGreater(scoped['unparsedRecords'], 0)

    def test_unfinished_scoped_network_call_is_not_dropped(self):
        scoped, _ = self.parse(self.base() + ['2<host> connect(4, <unfinished ...>'])
        self.assertEqual(scoped['unparsedRecords'], 1)

    def test_interleaved_fork_and_exec_resumption_preserves_edges(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=CLONE_VFORK|SIGCHLD <unfinished ...>',
            '3<native> execve("/owned/other", [...], 0x1 /* 1 var */ <unfinished ...>',
            '2<host> <... clone resumed>) = 3<native>',
            '3<native> <... execve resumed>) = 0', f'3<native> {CONNECT}'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))

    def test_proc_self_exec_uses_inherited_image_not_comm_or_auditor(self):
        scoped, whole = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<host>',
            '3<host> execve("/proc/self/exe", [...], 0x1 /* 1 var */) = 0',
            f'3<host> {CONNECT}',
            '2<host> clone(child_stack=NULL, flags=SIGCHLD) = 4<renderer>',
            '4<renderer> execve("/proc/self/exe", [...], 0x1 /* 1 var */) = 0',
            f'4<renderer> {CONNECT}'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))
        self.assertEqual(whole['externalAttempts'], 2)
        self.assertEqual(scoped['rootPids'], [2, 4])

    def test_inherited_connected_socket_peer_is_not_exempt(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> sendto(8<TCP:[127.0.0.1:123->203.0.113.1:443]>, ""..., 3, 0, NULL, 0) = 3',
            '2<host> sendmsg(9<UDPv6:[[::1]:123->[::1]:53]>, {msg_name=NULL, msg_iov=[...]}, 0) = 3'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (2, 1))
        self.assertIn('udp_write_untracked_fd', {i['reason'] for i in scoped['classificationIssues']})

    def test_unknown_socket_peer_and_abbreviated_vector_are_incomplete(self):
        for line in ['sendto(8<socket:[123]>, ""..., 3, 0, NULL, 0) = 3',
                     'sendmmsg(8, [...], 2, 0) = 2']:
            with self.subTest(line=line):
                scoped, _ = self.parse(self.base() + ['2<host> ' + line])
                self.assertGreater(scoped['unparsedRecords'], 0)

    def test_missing_child_and_truncated_lifecycle_fail_closed(self):
        scoped, _ = self.parse(self.base() + ['2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<lost>'])
        self.assertGreater(scoped['classificationErrors'], 0)
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory)/'trace'
            trace.write_text('1<app> execve("/owned/app", [...], 0x1 /* 1 var */) = 0\n')
            _scoped, whole = audit.analyze_processes([trace], require_lifecycle=True)
            self.assertGreater(whole['unparsedRecords'], 0)

    def test_namespaced_fork_return_uses_tracer_pid_without_colliding(self):
        scoped, _ = self.parse(self.base() + [
            "2<host> clone(child_stack=NULL, flags=CLONE_NEWPID|SIGCHLD) = 2<worker> /* 99 in strace's PID NS */",
            '99<worker> execve("/owned/worker", [...], 0x1 /* 1 var */) = 0',
            f'99<worker> {CONNECT}'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))
        self.assertEqual(next(p for p in scoped['processes'] if p['pid'] == 99)['parentPid'], 2)

    def test_classification_diagnostics_preserve_failure_without_trace_secrets(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<lost>',
            '4<orphan> execve("./SYNTHETIC_PATH_SECRET", [...], 0x1 /* 1 var */) = 0'])
        self.assertEqual(scoped['classificationErrors'], len(scoped['classificationIssues']))
        self.assertEqual({issue['reason'] for issue in scoped['classificationIssues']},
                         {'relative_exec_filename', 'missing_child_records', 'missing_fork_edge'})
        self.assertNotIn('SYNTHETIC_PATH_SECRET', json.dumps(scoped))

    def test_killed_sibling_register_decode_stub_remains_in_its_own_tree(self):
        scoped, whole = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>',
            '3<renderer> ???( <unfinished ...>',
            '3<renderer> +++ killed by SIGTERM +++',
            '2<host> +++ exited with 0 +++', '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (0, 0))
        self.assertEqual((whole['classificationErrors'], whole['unparsedRecords']), (0, 1))
        self.assertEqual(next(p for p in whole['processes'] if p['pid'] == 3)['unparsedRecords'], 1)

    def test_same_terminal_stub_inside_selected_tree_still_fails(self):
        for lines in [self.base() + ['2<host> ???( <unfinished ...>', '2<host> +++ killed by SIGTERM +++'],
                      self.base() + ['2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<renamed>',
                                     '3<renamed> ???( <unfinished ...>', '3<renamed> +++ killed by SIGKILL +++',
                                     '2<host> +++ exited with 0 +++']]:
            with self.subTest(lines=lines):
                scoped, _ = self.parse(lines + ['1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertEqual(scoped['unparsedRecords'], 1)

    def test_terminal_stub_never_hides_missing_ancestry_or_lifecycle(self):
        for extra in [
            ['3<orphan> ???( <unfinished ...>', '3<orphan> +++ killed by SIGTERM +++'],
            ['1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>', '3<renderer> ???( <unfinished ...>'],
        ]:
            with self.subTest(extra=extra):
                scoped, _ = self.parse(self.base() + extra + [
                    '2<host> +++ exited with 0 +++', '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertGreater(scoped['classificationErrors'], 0)

    def test_only_exact_final_stub_with_signal_death_is_attributable(self):
        for extra in [
            ['3<renderer> ???( <unfinished ...>', '3<renderer> +++ exited with 0 +++'],
            ['3<renderer> ???( <unfinished ...>', f'3<renderer> {CONNECT}', '3<renderer> +++ killed by SIGTERM +++'],
            ['3<renderer> ???( <unfinished ...>', '3<renderer> ???( <unfinished ...>', '3<renderer> +++ killed by SIGTERM +++'],
            ['3<renderer> ???( <unfinished ...>', '3<renderer> +++ killed by SIGTERM +++', '3<renderer> +++ killed by SIGTERM +++'],
            ['3<renderer> ???(NULL) = 0', '3<renderer> +++ killed by SIGTERM +++'],
        ]:
            with self.subTest(extra=extra):
                scoped, _ = self.parse(self.base() + [
                    '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>', *extra,
                    '2<host> +++ exited with 0 +++', '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertGreater(scoped['classificationErrors'], 0)

    def test_pending_fork_or_exec_is_fatal_even_for_killed_sibling(self):
        for call in ['clone(child_stack=NULL, flags=SIGCHLD', 'execve("/unknown/image", [...], 0x1']:
            with self.subTest(call=call):
                scoped, _ = self.parse(self.base() + [
                    '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>',
                    '3<renderer> ' + call + ' <unfinished ...>',
                    '3<renderer> ???( <unfinished ...>', '3<renderer> +++ killed by SIGTERM +++',
                    '2<host> +++ exited with 0 +++', '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertGreater(scoped['classificationErrors'], 0)

    def test_io_uring_is_classified_inside_selected_tree_including_failed_calls(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> io_uring_setup(2, {...}) = -1 EPERM (Operation not permitted)',
            '2<host> io_uring_enter(9, 1, 1, 0, NULL, 8) = -1 EBADF (Bad file descriptor)',
            '2<host> io_uring_register(9, 0, NULL, 0) = -1 EBADF (Bad file descriptor)'])
        self.assertEqual(scoped['externalAttempts'], 0)
        self.assertEqual(scoped['classificationErrors'], 3)
        self.assertEqual({i['syscall'] for i in scoped['classificationIssues']},
                         {'io_uring_setup', 'io_uring_enter', 'io_uring_register'})

    def test_io_uring_of_known_sibling_is_retained_only_in_whole_report(self):
        scoped, whole = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<sibling>',
            '3<sibling> io_uring_setup(2, {...}) = 9'])
        self.assertEqual(scoped['classificationErrors'], 0)
        self.assertEqual(whole['classificationErrors'], 1)
        self.assertEqual(next(p for p in whole['processes'] if p['pid'] == 3)['ioUringSyscalls'], ['io_uring_setup'])

    def test_unfinished_io_uring_in_selected_child_never_becomes_zero(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<renamed>',
            '3<renamed> io_uring_enter(9, 1, 1, 0, NULL, 8 <unfinished ...>'])
        self.assertEqual(scoped['classificationErrors'], 1)

    def test_only_loopback_accepted_socket_can_precede_allowed_ring_writes(self):
        for address,expected in [('127.0.0.1',0),('203.0.113.1',1)]:
            with self.subTest(address=address):
                accepted=f'accept4(3, {{sa_family=AF_INET, sin_port=htons(12345), sin_addr=inet_addr("{address}")}}, [16], SOCK_CLOEXEC) = 5'
                scoped,_=self.parse(self.base()+['2<host> '+accepted])
                self.assertEqual(scoped['classificationErrors'],expected)
        scoped,_=self.parse(self.base()+['2<host> accept4(3, NULL, NULL, 0) = 5<socket:[123]>'])
        self.assertEqual(scoped['unparsedRecords'],1)

    def test_numeric_setup_flags_with_strace_comments_match_kernel_creation(self):
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,'eventCount':2,
                 'events':[{'kind':'create','time':1,'ctx':'opaque','pid':2,'tgid':2,'fd':5,'flags':65536},
                           {'kind':'submit','time':2,'ctx':'opaque','pid':2,'tgid':2,'opcode':29,'sqpoll':False}]}
        capture['network']={'complete':True,'events':[],'eventCount':0,
                            'tasks':[{'pid':pid,'tgid':pid,'kernelPid':pid,'kernelTgid':pid,'start':1,'end':10,'lastOrdinal':10,
                                      'parentKernelPid':1000 if pid==1 else 1} for pid in (1,2)]}
        capture['root']={'kernelPid':1000,'pid':1000}
        capture['network']['tasks'].append({'pid':1000,'tgid':1000,'kernelPid':1000,'kernelTgid':1000,'start':1,'end':10,'lastOrdinal':0})
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'trace'
            trace.write_text('\n'.join(self.base()+[
                '2<host> io_uring_setup(256, {flags=0x10000 /* IORING_SETUP_??? */}) = 5<anon_inode:[io_uring]>',
                '2<host> io_uring_enter(5<anon_inode:[io_uring]>, 1, 0, 0, NULL, 8) = 1'])+'\n')
            scoped,_=audit.analyze_processes([trace],(HOST,),(HOST,),False,capture)
        self.assertEqual(scoped['classificationIssues'],[])
        self.assertEqual(scoped['ioUring']['opcodeCounts'],{'EPOLL_CTL':1})

    def test_paired_capture_does_not_erase_unfinished_ring_syscall(self):
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,'eventCount':0,'events':[]}
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'trace'
            trace.write_text('\n'.join(self.base()+['2<host> io_uring_setup(8, <unfinished ...>'])+'\n')
            scoped,_=audit.analyze_processes([trace],(HOST,),(HOST,),False,capture)
        self.assertGreater(scoped['classificationErrors'],0)

    def test_c_escaped_unicode_path_matches_without_disclosing_path(self):
        from outboundScope import decode_path
        self.assertEqual(decode_path(r'"/owned/\355\225\234\352\270\200"'), '/owned/한글')
        scoped, _ = self.parse(self.base())
        self.assertNotIn(HOST, json.dumps(scoped))


@unittest.skipUnless(sys.platform == 'linux', 'Linux process tracing required')
class ScopedTraceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('strace') or not shutil.which('cc'):
            raise RuntimeError('Scoped Linux integration tests require strace and cc')

    def test_real_io_uring_connect_cannot_pass_as_zero_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'uring.c'
            source.write_text('''#define _GNU_SOURCE
#include <unistd.h>
#include <sys/syscall.h>
#include <linux/io_uring.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#ifdef USE_LIBURING
#include <liburing.h>
#endif
int main(void) {
#ifdef USE_LIBURING
    struct io_uring ring;
    if (io_uring_queue_init(2, &ring, 0) == 0) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in address = {.sin_family=AF_INET,.sin_port=htons(9)};
        inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
        io_uring_prep_connect(io_uring_get_sqe(&ring), fd, (void*)&address, sizeof(address));
        io_uring_submit(&ring);
        struct io_uring_cqe *completion;
        if (io_uring_wait_cqe(&ring, &completion) == 0) io_uring_cqe_seen(&ring, completion);
        close(fd); io_uring_queue_exit(&ring);
    }
#else
    struct io_uring_params params = {0};
    long fd = syscall(SYS_io_uring_setup, 2, &params);
    if (fd >= 0) close(fd);
#endif
    syscall(SYS_io_uring_enter, -1, 0, 0, 0, 0, 0);
    syscall(SYS_io_uring_register, -1, 0, 0, 0);
    return 0;
}
''')
            binary = root/'uring-control'
            linked = shutil.which('pkg-config') and subprocess.run(['pkg-config','--exists','liburing']).returncode == 0
            flags = ['-DUSE_LIBURING','-luring'] if linked else []
            subprocess.run(['cc',str(source),'-o',str(binary),*flags],check=True)
            result = subprocess.run([sys.executable,'-B',str(SCRIPT),'--report',str(root/'report.json'),
                                     '--scope-executable',str(binary),'--require-executable',str(binary),
                                     '--',str(binary)],capture_output=True,text=True,timeout=30)
            report = json.loads((root/'report.json').read_text())
            self.assertEqual(result.returncode,87,result.stderr)
            self.assertGreaterEqual(report['classificationErrors'],1)
            self.assertEqual(report['externalAttempts'],0)

    def test_real_different_executable_child_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'control.c'
            source.write_text('#include <sys/socket.h>\n#include <arpa/inet.h>\n#include <unistd.h>\n'
                              'int main(){struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(9)};'
                              'inet_pton(AF_INET,"203.0.113.1",&a.sin_addr);'
                              'int s=socket(AF_INET,SOCK_DGRAM,0);'
                              'sendto(s,"",0,0,(void*)&a,sizeof(a));close(s);return 0;}\n')
            worker = root / 'native-control'
            subprocess.run(['cc', str(source), '-o', str(worker)], check=True)
            selected = Path(sys.executable).resolve()
            # A different executable launched by Python must remain inside its tree.
            shell = root / 'run.sh'
            shell.write_text(f'#!/bin/sh\nexec {selected} -c "import subprocess;subprocess.run([\'{worker}\'])" SYNTHETIC_ARGUMENT_SECRET\n')
            env = dict(os.environ, SYNTHETIC_ENV_SECRET='synthetic-value')
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--report', str(root/'scoped.json'),
                                     '--scope-executable', str(selected), '--require-executable', str(selected),
                                     '--whole-report', str(root/'whole.json'), '--', '/bin/sh', str(shell)],
                                    env=env, capture_output=True, text=True, timeout=30)
            scoped = json.loads((root/'scoped.json').read_text())
            whole = json.loads((root/'whole.json').read_text())
            self.assertEqual(result.returncode, 86, result.stderr)
            self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))
            self.assertEqual(whole['externalAttempts'], 1)
            self.assertNotIn('SYNTHETIC_ARGUMENT_SECRET', json.dumps(whole))
            self.assertNotIn('SYNTHETIC_ENV_SECRET', json.dumps(whole))

    def test_zero_selected_tree_and_external_sibling_do_not_share_a_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # Select /bin/true, while Python's explicit control is a sibling, not its child.
            driver = root/'driver.py'
            driver.write_text('import subprocess,sys\nsubprocess.run(["/bin/true"])\n'
                              'subprocess.run([sys.executable,"-I","-B",sys.argv[1],"--positive-control"])\n')
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--report', str(root/'scoped.json'),
                                     '--scope-executable', '/bin/true', '--require-executable', '/bin/true',
                                     '--whole-report', str(root/'whole.json'), '--', sys.executable, '-I', '-B', str(driver), str(SCRIPT)],
                                    capture_output=True, text=True, timeout=30)
            scoped = json.loads((root/'scoped.json').read_text()); whole = json.loads((root/'whole.json').read_text())
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (0, 0))
            self.assertEqual(whole['externalAttempts'], 2)


    def test_trace_suppresses_argument_and_environment_sentinels(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory)/'report.json'
            original = audit.analyze_processes
            inspected = []
            def inspect(paths, *args):
                raw = ''.join(path.read_text() for path in paths)
                self.assertNotIn('SYNTHETIC_ARGUMENT_SECRET', raw)
                self.assertNotIn('SYNTHETIC_ENV_SECRET', raw)
                inspected.append(True)
                return original(paths, *args)
            with patch.object(audit, 'analyze_processes', inspect), patch.dict(os.environ, SYNTHETIC_ENV_SECRET='hidden'):
                result = audit.audit(['/bin/true','SYNTHETIC_ARGUMENT_SECRET'], report)
            self.assertEqual(result, 0)
            self.assertTrue(inspected)


    def test_real_inherited_udp_socket_and_message_vector_are_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'worker.c'
            source.write_text('#define _GNU_SOURCE\n#include <sys/socket.h>\n#include <stdlib.h>\n#include <unistd.h>\n'
                              'int main(int argc,char **argv){int fd=atoi(argv[1]);'
                              'struct iovec iov={.iov_base="SYNTHETIC_PAYLOAD_SECRET",.iov_len=24};'
                              'struct mmsghdr m[2]={0};'
                              'for(int i=0;i<2;i++){m[i].msg_hdr.msg_iov=&iov;m[i].msg_hdr.msg_iovlen=1;}'
                              'sendmmsg(fd,m,2,0);close(fd);return 0;}\n')
            worker = root/'worker'
            subprocess.run(['cc',str(source),'-o',str(worker)],check=True)
            driver = root/'driver.py'
            # Use an owned UDP receiver on this machine's non-loopback interface.
            # This is external under the audit policy, without relying on remote replies.
            driver.write_text('import socket,subprocess,sys\n'
                              's=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\n'
                              's.connect(("203.0.113.1",9))\n'
                              'ip=s.getsockname()[0]\n'
                              'receiver=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\n'
                              'receiver.bind((ip,0))\n'
                              's.connect(receiver.getsockname())\n'
                              'subprocess.run([sys.argv[1],str(s.fileno())],pass_fds=(s.fileno(),))\ns.close();receiver.close()\n')
            from unittest.mock import patch
            original = audit.analyze_processes
            def inspect(paths, *args):
                self.assertNotIn('SYNTHETIC_PAYLOAD_SECRET', ''.join(path.read_text() for path in paths))
                return original(paths, *args)
            with patch.object(audit, 'analyze_processes', inspect):
                result = audit.audit([sys.executable,'-I','-B',str(driver),str(worker)], root/'scoped.json',
                                     scope_executables=(worker,), require_executables=(worker,), whole_report_path=root/'whole.json')
            scoped = json.loads((root/'scoped.json').read_text())
            self.assertEqual(result,86)
            self.assertEqual(scoped['externalAttempts'],2)
            self.assertEqual(scoped['unparsedRecords'],0)


    def test_real_loopback_accepted_and_connected_sockets_remain_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            driver = root/'loopback.py'
            driver.write_text('import socket,threading\n'
                              'server=socket.socket();server.bind(("127.0.0.1",0));server.listen()\n'
                              'def respond():\n'
                              ' c,_=server.accept();c.recv(10);c.sendall(b"reply");c.close()\n'
                              'thread=threading.Thread(target=respond);thread.start()\n'
                              'client=socket.create_connection(server.getsockname());client.sendall(b"request")\n'
                              'assert client.recv(10)==b"reply"\n'
                              'client.close();thread.join();server.close()\n')
            result = subprocess.run([sys.executable,'-B',str(SCRIPT),'--report',str(root/'scoped.json'),
                                     '--scope-executable',sys.executable,'--require-executable',sys.executable,
                                     '--',sys.executable,'-I','-B',str(driver)],capture_output=True,text=True,timeout=30)
            scoped = json.loads((root/'scoped.json').read_text())
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual((scoped['externalAttempts'],scoped['unparsedRecords']),(0,0))
            self.assertGreater(scoped['destinationAttempts'],0)


class TracerSelectionTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux' and shutil.which('strace'), 'Linux audit runtime test')
    def test_receiving_socket_data_does_not_create_an_unmatched_send_operation(self):
        import socket
        import threading
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);endpoint=root/'local.sock';report=root/'report.json'
            server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            server.bind(str(endpoint));server.listen();server.settimeout(0.1)
            stop=threading.Event()
            def serve():
                while not stop.is_set():
                    try:connection,_=server.accept()
                    except socket.timeout:continue
                    except OSError:return
                    with connection:connection.sendall(b'control')
                    return
            worker=threading.Thread(target=serve);worker.start()
            try:
                code='import socket,os,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);assert s.recvmsg(3)[0]==b"con";assert os.readv(s.fileno(),[bytearray(4)])==4;s.close()'
                result=audit.audit([sys.executable,'-I','-B','-c',code,str(endpoint)],report)
                data=json.loads(report.read_text())
                self.assertEqual(result,0)
                self.assertEqual((data['externalAttempts'],data['unparsedRecords'],data['classificationErrors']),(0,0,0))
                self.assertTrue(data['kernelNetwork']['recorded'])
            finally:
                stop.set();server.close();worker.join(timeout=5)

    def test_pinned_binary_is_selected_without_relying_on_sudo_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);binary=root/'.local/strace-toolchain/bin/strace'
            binary.parent.mkdir(parents=True);binary.write_text('fixture')
            with patch.object(audit.shutil,'which',return_value='/usr/bin/strace'):
                self.assertEqual(audit.resolve_strace(root),str(binary))

    def test_unsupported_abi_diagnostic_is_detected_without_retaining_contents(self):
        warning='strace: WARNING: Proper structure decoding for this personality is not supported, please consider building strace with mpers support enabled.'
        self.assertEqual(audit.unsupported_personalities(warning),1)
        self.assertEqual(audit.unsupported_personalities('normal synthetic application diagnostics'),0)

    @unittest.skipUnless(sys.platform == 'linux' and shutil.which('strace'), 'Linux audit runtime test')
    def test_unsupported_personality_warning_blocks_an_otherwise_successful_command(self):
        with tempfile.TemporaryDirectory() as directory:
            report=Path(directory)/'report.json'
            warning='strace: WARNING: Proper structure decoding for this personality is not supported, please consider building strace with mpers support enabled.'
            code=audit.audit([sys.executable,'-I','-B','-c','import sys;sys.stderr.write('+repr(warning+'\n')+')'],report)
            data=json.loads(report.read_text())
            self.assertEqual(code,87)
            self.assertEqual(data['straceDiagnostics']['unsupportedPersonalities'],1)
            self.assertIn({'reason':'unsupported_strace_personality'},data['classificationIssues'])
