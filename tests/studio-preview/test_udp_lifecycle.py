"""The app and host use exactly one transport/lifecycle classification policy."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('shared_audit', ROOT/'scripts/studio-preview/fixtures/outboundAudit.py')
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)
SOCKET = '1<app> socket(AF_INET6, SOCK_DGRAM|SOCK_CLOEXEC, IPPROTO_UDP) = 3<UDPv6:[123]>'
CONNECT = '1<app> connect(3<UDPv6:[123]>, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr)}, 28) = -1 ENETUNREACH'
CLOSE = '1<app> close(3<UDPv6:[123]>) = 0'
END = '1<app> +++ exited with 0 +++'


class UdpLifecycleTests(unittest.TestCase):
    def parse(self, lines, capture=None):
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'trace';trace.write_text('\n'.join(lines)+'\n')
            return audit.analyze_processes([trace],require_lifecycle=True,kernel_capture=capture)[0]

    def test_closed_unsent_association_is_recorded_without_address_exception(self):
        for address in ('2001:db8::1','2001:4860:4860::8888','::ffff:203.0.113.1'):
            report=self.parse([SOCKET,CONNECT.replace('2001:db8::1',address),CLOSE,END])
            self.assertEqual((report['externalAttempts'],report['unparsedRecords'],report['udpConnectOnly']),(0,0,1))

    def test_every_write_family_promotes_association_even_on_failure(self):
        for call,args in [('write','""..., 1'),('writev','[...], 1'),('sendto','""..., 1, 0, NULL, 0'),
                          ('sendmsg','{msg_name=NULL, msg_iov=[...]}, 0'),('sendmmsg','[{msg_hdr={msg_name=NULL, msg_iov=[...]}}], 1, 0')]:
            report=self.parse([SOCKET,CONNECT,f'1<app> {call}(3<UDPv6:[123]>, {args}) = -1 ENOTCONN',CLOSE,END])
            self.assertEqual((report['externalAttempts'],report['unparsedRecords'],report['udpConnectOnly']),(2,0,0),call)

    def test_fork_dup_and_shared_thread_writes_keep_original_socket_identity(self):
        for flags in ('SIGCHLD','CLONE_FILES|CLONE_THREAD|SIGCHLD'):
            lines=[SOCKET,CONNECT,f'1<app> clone(child_stack=NULL, flags={flags}) = 2<child>',
                   '2<child> dup(3<UDPv6:[123]>) = 7<UDPv6:[123]>',
                   '2<child> writev(7<UDPv6:[123]>, [...], 1) = -1 ENOTCONN',
                   '2<child> close(7<UDPv6:[123]>) = 0','2<child> close(3<UDPv6:[123]>) = 0',
                   '2<child> +++ exited with 0 +++',CLOSE,END]
            report=self.parse(lines)
            self.assertEqual((report['externalAttempts'],report['unparsedRecords'],report['udpConnectOnly']),(2,0,0))

    def test_missing_close_or_child_exit_with_open_socket_fails(self):
        for lines in ([SOCKET,CONNECT,END],[SOCKET,CONNECT],
                      [SOCKET,CONNECT,'1<app> fork() = 2<child>','2<child> +++ exited with 0 +++',CLOSE,END]):
            self.assertGreater(self.parse(lines)['classificationErrors'],0)

    def test_fd_reuse_does_not_make_a_later_file_write_a_udp_send(self):
        report=self.parse([SOCKET,CONNECT,CLOSE,'1<app> write(3</tmp/local>, ""..., 1) = 1',END])
        self.assertEqual((report['externalAttempts'],report['unparsedRecords'],report['udpConnectOnly']),(0,0,1))

    def test_ring_writev_with_unobservable_fd_blocks_udp_exemption(self):
        # Supply real policy-shaped records: capture reconciliation still checks
        # creator PID/TGID, flags, setup/enter and kernel submission count.
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,'eventCount':2,
                 'events':[{'kind':'create','time':1,'ctx':'ring','pid':1,'tgid':1,'fd':5,'flags':0},
                           {'kind':'submit','time':2,'ctx':'ring','pid':1,'tgid':1,'opcode':2,'sqpoll':False}]}
        report=self.parse([SOCKET,CONNECT,'1<app> io_uring_setup(8, {flags=0}) = 5<anon_inode:[io_uring]>',
                           '1<app> io_uring_enter(5<anon_inode:[io_uring]>, 1, 1, 0, NULL, 0) = 1',CLOSE,END],capture)
        self.assertIn('udp_io_uring_write_fd_unproven',{r['reason'] for r in report['classificationIssues']})

    def test_process_sharing_table_before_socket_creation_cannot_hide_ring_write(self):
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,'eventCount':2,
                 'events':[{'kind':'create','time':1,'ctx':'ring','pid':2,'tgid':2,'fd':5,'flags':0},
                           {'kind':'submit','time':2,'ctx':'ring','pid':2,'tgid':2,'opcode':2,'sqpoll':False}]}
        report=self.parse(['1<app> clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = 2<child>',SOCKET,CONNECT,
                           '2<child> io_uring_setup(8, {flags=0}) = 5<anon_inode:[io_uring]>',
                           '2<child> io_uring_enter(5<anon_inode:[io_uring]>, 1, 1, 0, NULL, 0) = 1',
                           '2<child> +++ exited with 0 +++',CLOSE,END],capture)
        self.assertIn('udp_io_uring_write_fd_unproven',{r['reason'] for r in report['classificationIssues']})

    def test_unknown_write_result_cannot_be_classified_as_unsent(self):
        for result in ('? ERESTARTSYS (To be restarted)', '?', 'malformed'):
            report=self.parse([SOCKET,CONNECT,f'1<app> write(3<UDPv6:[123]>, ""..., 7) = {result}',CLOSE,END])
            self.assertEqual(report['udpConnectOnly'],0)
            self.assertGreater(report['unparsedRecords'],0)

    def test_unknown_sockaddr_is_incomplete(self):
        report=self.parse(['1<app> connect(2, 0x123456, 16) = -1 EFAULT',END])
        self.assertGreater(report['unparsedRecords'],0)

    def test_zero_protocol_alias_is_udp_but_ping_sockets_are_not(self):
        for protocol in ('0','IPPROTO_IP'):
            report=self.parse([SOCKET.replace('IPPROTO_UDP',protocol),CONNECT,CLOSE,END])
            self.assertEqual((report['externalAttempts'],report['udpConnectOnly']),(0,1))
        report=self.parse([SOCKET.replace('IPPROTO_UDP','IPPROTO_ICMPV6'),CONNECT,CLOSE,END])
        self.assertEqual((report['externalAttempts'],report['udpConnectOnly']),(1,0))

    def test_last_task_of_process_cannot_leave_udp_open_in_another_process_table(self):
        report=self.parse([SOCKET,CONNECT,'1<app> clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = 2<child>',
                           '2<child> +++ exited with 0 +++',CLOSE,END])
        self.assertGreater(report['classificationErrors'],0)
        self.assertEqual(report['udpConnectOnly'],0)

    def test_surviving_thread_may_close_the_same_process_shared_table(self):
        report=self.parse([SOCKET,CONNECT,'1<app> clone(child_stack=NULL, flags=CLONE_FILES|CLONE_THREAD|SIGCHLD) = 2<thread>',
                           '2<thread> +++ exited with 0 +++',CLOSE,END])
        self.assertEqual((report['externalAttempts'],report['unparsedRecords'],report['udpConnectOnly']),(0,0,1))

    def test_tcp_connect_remains_an_attempt_even_without_data(self):
        report=self.parse([CONNECT.replace('UDPv6','TCPv6'),END])
        self.assertEqual((report['externalAttempts'],report['udpConnectOnly']),(1,0))
