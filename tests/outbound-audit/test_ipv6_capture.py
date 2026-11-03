import importlib.util
import ipaddress
from pathlib import Path
import struct
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ipv6_capture', ROOT / 'scripts/outbound-audit/ipv6Capture.py')
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


def capture_frame(destination, protocol=17):
    frame = b'\x00' * 12 + b'\x86\xdd'
    frame += struct.pack('!IHBB16s16s', 0x60000000, 8, protocol, 64,
                         ipaddress.IPv6Address('2001:db8:15::1').packed,
                         ipaddress.IPv6Address(destination).packed)
    return struct.pack('<IIII', 0, 0, len(frame), len(frame) + 8) + frame


class CaptureTests(unittest.TestCase):
    def parse(self, records=b'', snaplen=54):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'capture.pcap'
            path.write_bytes(struct.pack('<IHHIIII', 0xa1b2c3d4, 2, 4, 0, 0, snaplen, 1) + records)
            return lab.read_pcap(path)

    def test_empty_capture_has_zero_packets(self):
        self.assertEqual(self.parse()['frames'], 0)

    def test_positive_control_detects_exact_probe_destination_without_payload(self):
        result = self.parse(capture_frame(lab.PROBE))
        self.assertEqual((result['frames'], result['toProbe'], result['udp']), (1, 1, 1))

    def test_configured_ipv6_endpoint_is_counted_separately(self):
        result = self.parse(capture_frame(lab.PEER, 6))
        self.assertEqual((result['frames'], result['toProbe'], result['tcp']), (1, 0, 1))

    def test_truncated_packet_is_never_zero_evidence(self):
        with self.assertRaises(ValueError):
            self.parse(capture_frame(lab.PROBE)[:-1])

    def test_payload_permitting_capture_format_is_rejected(self):
        with self.assertRaises(ValueError):
            self.parse(snaplen=65535)


class SyscallTests(unittest.TestCase):
    def parse(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'trace'
            path.write_text(text)
            return lab.parse_trace(path)

    def test_joins_interleaved_udp_connect_entry_and_return(self):
        result = self.parse('''2<network> connect(5<UDPv6:[12]>, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr)}, 28 <unfinished ...>
3<main> getsockname(4, {sa_family=AF_INET}, [16]) = 0
2<network> <... connect resumed>) = -1 ENETUNREACH
''')
        self.assertEqual(result['probeConnects'], 1)
        self.assertIn('ENETUNREACH', result['probeConnectResults'][0])

    def test_unknown_return_is_not_assumed_successful(self):
        with self.assertRaises(ValueError):
            self.parse('2<network> connect(5, <unfinished ...>\n')

    def test_interrupted_send_to_probe_is_not_silently_dropped(self):
        with self.assertRaises(ValueError):
            self.parse('2<network> sendto(5<UDPv6:[2001:4860:4860::8888]>, ""..., 9, 0, NULL, 0 <unfinished ...>\n2<network> +++ killed by SIGTERM +++\n')

    def test_tcp_descriptor_is_not_reported_as_a_udp_route_probe(self):
        with self.assertRaises(ValueError):
            self.parse('2<network> connect(5<TCPv6:[12]>, {sa_family=AF_INET6, inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr)}, 28) = 0\n')


if __name__ == '__main__':
    unittest.main()
