"""Compatibility path must delegate to main; policy tests live in studio-preview."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('app_audit', ROOT/'scripts/outbound-audit/audit.py')
wrapper = importlib.util.module_from_spec(spec); spec.loader.exec_module(wrapper)
import outboundAudit


class SharedPolicyTests(unittest.TestCase):
    def test_app_gate_calls_the_same_auditor_as_host_native(self):
        self.assertIs(wrapper.audit, outboundAudit.audit)
        self.assertIs(wrapper.main, outboundAudit.main)

    def test_old_destination_policy_cannot_diverge(self):
        self.assertFalse((ROOT/'scripts/outbound-audit/destinationPolicy.py').exists())
