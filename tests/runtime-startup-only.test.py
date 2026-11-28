import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1]/'scripts/verify-android-native-compatibility-runtime.py'
spec = importlib.util.spec_from_file_location('startup_only_runtime', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
HOME = '<hierarchy><node package="'+m.PACKAGE+'" content-desc="Import a video" clickable="true" enabled="true" bounds="[20,200][300,400]" /></hierarchy>'
OFFLINE = 'Active default network: none\nCurrent Networks:\n\nNetwork Requests:\n'

class StartupOnly(unittest.TestCase):
    def exercise(self, directory, mode):
        calls, installed, logs, pid_calls = [], [False], [], [0]
        request = {'expected_source_commit':'a'*40, 'receipt_sha256':'b'*64,
                   'aab_sha256':'c'*64, 'solana_sha256':'d'*64, 'play_sha256':'e'*64}
        env = dict(GITHUB_ACTIONS='true', GITHUB_EVENT_NAME='workflow_dispatch',
            GITHUB_REPOSITORY=m.REPO, GITHUB_REPOSITORY_OWNER='Hatsunama',
            GITHUB_ACTOR='Hatsunama', GITHUB_TRIGGERING_ACTOR='Hatsunama',
            GITHUB_REF='refs/heads/codex/final150-runtime-diagnostic',
            GITHUB_WORKFLOW_REF=m.REPO+'/.github/workflows/verify-final-android-runtime.yml@refs/heads/codex/final150-runtime-diagnostic',
            GITHUB_SHA='f'*40, GH_TOKEN='', GITHUB_TOKEN='')
        def run(args, *a, **kw):
            args = list(map(str, args)); calls.append(args)
            if args == ['adb', 'devices']:
                return 'List of devices attached\nemulator-5554\tdevice\n'
            self.assertEqual(args[:3], ['adb', '-s', m.SERIAL])
            command = args[3:]
            if command[:2] == ['shell', 'getprop']:
                return {'ro.kernel.qemu':'1', 'ro.build.version.sdk':'25',
                        'ro.config.low_ram':'false',
                        'ro.product.cpu.abilist':'x86_64,x86'}[command[-1]]+'\n'
            if command == ['shell', 'cat', '/proc/meminfo']:
                return 'MemTotal: 2097152 kB\n'
            if command[:4] == ['shell', 'settings', 'put', 'global'] or command[:4] == ['shell', 'settings', 'put', 'secure']:
                return ''
            if command[:4] == ['shell', 'settings', 'get', 'global']:
                return '1\n'
            if command == ['shell', 'dumpsys', 'connectivity', '--short']:
                return OFFLINE
            if command[:5] == ['shell', 'su', '0', 'am', 'broadcast']:
                return 'Broadcast completed: result=0\n'
            if command == ['shell', 'pm', 'list', 'packages', m.PACKAGE]:
                return ('package:'+m.PACKAGE+'\n') if installed[0] else ''
            if command == ['shell', 'pm', 'uninstall', m.PACKAGE]:
                installed[0] = False; return 'Success\n'
            if command[:2] == ['install', '--no-streaming']:
                installed[0] = True; return 'Success\n'
            if command == ['shell', 'am', 'force-stop', m.PACKAGE]:
                return ''
            if command[:3] == ['shell', 'log', '-p']:
                logs.append('11-28 01:00:00.000  1  1 I CaptionStudioRuntime: '+command[-1]+'\n'); return ''
            if command[:3] == ['shell', 'am', 'start']:
                return 'Status: ok\n'
            if command == ['shell', 'pidof', m.PACKAGE]:
                pid_calls[0] += 1
                return ('456' if mode == 'restart' and pid_calls[0] > 1 else '123')+'\n'
            if command[:3] == ['shell', 'uiautomator', 'dump']:
                return 'UI hierarchy dumped\n'
            if command == ['exec-out', 'cat', '/sdcard/caption-runtime.xml']:
                return HOME
            if command == ['exec-out', 'screencap', '-p']:
                return b'PNG'
            if command == ['logcat', '-d', '-v', 'threadtime']:
                return ''.join(logs)+('FATAL EXCEPTION: main\n' if mode == 'crash' else '')
            raise AssertionError('Out-of-scope startup command: '+repr(command))
        with patch.dict(os.environ, env, clear=True), patch.object(m, 'workflow_request', return_value=request), \
             patch.object(m, 'validate_import'), patch.object(m, 'verify_files', return_value=(request, {})), \
             patch.object(m, 'run', side_effect=run), patch.object(m.time, 'sleep'):
            m.emulate(directory/'assets', directory/'evidence', 25, 'x86_64', directory/'tools')
        return json.loads((directory/'evidence/runtime-result.json').read_text()), calls

    def test_both_formats_start_without_media_model_or_feature_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            report, calls = self.exercise(Path(temporary), 'ok')
        self.assertTrue(report['startupOnly'])
        self.assertEqual([r['role'] for r in report['runs']], ['solana', 'play'])
        self.assertTrue(all(r['status']=='passed' and r['liveHomeSnapshots']==2 for r in report['runs']))
        self.assertEqual(sum(c[3:6] == ['shell','am','force-stop'] for c in calls), 2)

    def test_restarted_process_does_not_pass_startup(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(ValueError):
            self.exercise(Path(temporary), 'restart')

    def test_current_crash_does_not_pass_startup(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(ValueError):
            self.exercise(Path(temporary), 'crash')

if __name__ == '__main__':
    unittest.main()
