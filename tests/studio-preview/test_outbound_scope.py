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

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/studio-preview/fixtures/outboundAudit.py'
spec = importlib.util.spec_from_file_location('scoped_outbound_audit', SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

HOST = '/owned/aelix-studio-host'
PYTHON = '/owned/native/python3'
CONNECT = 'connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.1")}, 16) = -1 ENETUNREACH (Network unreachable)'
LOCAL = CONNECT.replace('203.0.113.1', '127.0.0.1')


class ScopedParserTests(unittest.TestCase):
    def parse(self, lines, roots=(HOST, PYTHON), required=(HOST,)):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'network.trace'
            trace.write_text('\n'.join(lines) + '\n')
            return audit.analyze_processes([trace], roots, required)

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
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (2, 0))

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
            source.write_text('#define _GNU_SOURCE\n#include <sys/socket.h>\n#include <stdlib.h>\n'
                              'int main(int argc,char **argv){int fd=atoi(argv[1]);'
                              'struct iovec iov={.iov_base="SYNTHETIC_PAYLOAD_SECRET",.iov_len=24};'
                              'struct mmsghdr m[2]={0};'
                              'for(int i=0;i<2;i++){m[i].msg_hdr.msg_iov=&iov;m[i].msg_hdr.msg_iovlen=1;}'
                              'sendmmsg(fd,m,2,0);return 0;}\n')
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
                              'subprocess.run([sys.argv[1],str(s.fileno())],pass_fds=(s.fileno(),))\n')
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
