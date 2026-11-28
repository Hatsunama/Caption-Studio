import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/verify-android-native-compatibility-runtime.py'
spec = importlib.util.spec_from_file_location('old_api_network', SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

# Actual API24 diagnostic layout; UID details are not relevant to network state.
API24 = '''NetworkFactories for: PhoneSwitcherNetworkRequstListener WIFI_UT WIFI

Active default network: none

Current Networks:

Metered Interfaces:

Restrict background: false

Status for known UIDs:
  UID=10014 rules=1 (ALLOW_METERED)

Network Requests:
  Request from uid/pid:1000/1614 for NetworkRequest [ id=1 ]
'''

class OldApiNetwork(unittest.TestCase):
    def test_actual_api24_empty_network_section_is_offline(self):
        self.assertTrue(runtime.guest_network_is_offline(API24))

    def test_api24_current_network_still_rejected_with_no_default(self):
        connected = API24.replace('Current Networks:\n', 'Current Networks:\n  NetworkAgentInfo WIFI connected\n')
        self.assertFalse(runtime.guest_network_is_offline(connected))

    def test_unknown_truncated_duplicate_and_live_states_still_rejected(self):
        for value in (API24.replace('none', '100'),
                      API24.split('Network Requests:')[0],
                      API24 + 'Current Networks:\n',
                      API24 + 'Network Requests:\n',
                      API24.replace('Metered Interfaces:', 'Unknown section:')):
            with self.subTest(snapshot=value):
                self.assertFalse(runtime.guest_network_is_offline(value))

if __name__ == '__main__':
    unittest.main()
