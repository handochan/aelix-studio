import importlib.util
from pathlib import Path
import tempfile
import unittest
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('audit', ROOT / 'scripts/outbound-audit/audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class TraceTests(unittest.TestCase):
    def parse(self, text):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'trace'
            trace.write_text(text)
            return audit.analyze_trace(trace)

    def test_counts_failed_external_dns_ipv6_and_child_attempts(self):
        result = self.parse('''1<driver> connect(1, {sa_family=AF_INET, sin_port=htons(8000), sin_addr=inet_addr("127.0.0.1")}, 16) = 0
2<Chrome_ChildIOT> connect(2, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr)}, 28) = -1 ENETUNREACH
3<python> sendto(3, ""..., 7, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.53")}, 16) = -1 ENETUNREACH
''')
        self.assertEqual(result['externalAttempts'], 2)
        self.assertEqual(result['unparsedRecords'], 0)
        self.assertEqual([p['tid'] for p in result['processes']], [2, 3])

    def test_interleaved_unfinished_calls_keep_their_own_thread(self):
        result = self.parse('''2<network> connect(2, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.1")}, 16 <unfinished ...>
3<driver> sendmsg(1, {msg_name=NULL, msg_namelen=0, msg_iov=[...]}, 0) = 1
2<network> <... connect resumed>) = -1 ECONNREFUSED
''')
        self.assertEqual(result['externalAttempts'], 1)
        self.assertEqual(result['unparsedRecords'], 0)

    def test_counts_attempt_even_if_the_process_dies_before_return(self):
        result = self.parse('''2<network> connect(2, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.1")}, 16 <unfinished ...>
2<network> +++ killed by SIGKILL +++
''')
        self.assertEqual(result['externalAttempts'], 1)
        self.assertEqual(result['unparsedRecords'], 0)
        self.assertEqual(result['interruptedSyscalls'], 1)

    @unittest.skipUnless(sys.platform == 'linux' and shutil.which('strace'), 'Linux strace runtime test')
    def test_normal_process_exit_accounts_for_a_blocked_thread_syscall(self):
        code = "import socket,threading,time,os; a,b=socket.socketpair(); threading.Thread(target=lambda:a.sendall(b'x'*4000000),daemon=True).start(); time.sleep(0.1); os._exit(0)"
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'report.json'
            self.assertEqual(audit.audit([sys.executable, '-c', code], report), 0)

    def test_sendmmsg_keeps_each_destination(self):
        result = self.parse('1<network> sendmmsg(2, [{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(8000), sin_addr=inet_addr("127.0.0.1")}}}, {msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("203.0.113.1")}}}], 2, 0) = 2\n')
        self.assertEqual(result['destinationAttempts'], 2)
        self.assertEqual(result['externalAttempts'], 1)

    def test_unknown_socket_address_fails_closed(self):
        result = self.parse('1<network> connect(2, 0x123456, 16) = -1 EFAULT\n')
        self.assertGreater(result['unparsedRecords'], 0)

    def test_missing_terminal_record_is_incomplete(self):
        result = self.parse('2<network> connect(2, <unfinished ...>\n')
        self.assertGreater(result['unparsedRecords'], 0)

    def test_unidentified_records_are_not_silently_dropped(self):
        self.assertEqual(self.parse('unidentified trace record\n')['unparsedRecords'], 1)

    def test_dns_and_ipv4_mapped_ipv6_cannot_bypass_policy(self):
        result = self.parse('''1<network> connect(1, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "::ffff:203.0.113.1", &sin6_addr)}, 28) = -1 ENETUNREACH
1<network> connect(2, {sa_family=AF_INET6, sin6_port=htons(8000), inet_pton(AF_INET6, "::ffff:127.0.0.1", &sin6_addr)}, 28) = 0
''')
        self.assertEqual(result['externalAttempts'], 1)
        self.assertEqual(result['unparsedRecords'], 0)


if __name__ == '__main__':
    unittest.main()
