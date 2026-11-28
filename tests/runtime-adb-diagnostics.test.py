"""Temporary diagnostic lifecycle tests. Standard library; no devices/network."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT/'scripts/verify-android-native-compatibility-runtime.py'
BRANCH = 'refs/heads/codex/final150-runtime-diagnostic'

class DiagnosticLifecycle(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('diagnostic_runtime', SCRIPT)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(GITHUB_ACTIONS='true', GITHUB_EVENT_NAME='workflow_dispatch',
            GITHUB_REPOSITORY=self.m.REPO, GITHUB_REPOSITORY_OWNER='Hatsunama',
            GITHUB_ACTOR='Hatsunama', GITHUB_TRIGGERING_ACTOR='Hatsunama',
            GITHUB_REF=BRANCH, GITHUB_WORKFLOW_REF=self.m.REPO+
            '/.github/workflows/verify-final-android-runtime.yml@'+BRANCH,
            GH_TOKEN='', GITHUB_TOKEN='')
        self.environment = patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.command = ['adb', '-s', self.m.SERIAL, 'install', '--no-streaming',
                        str(self.root/'assets'/self.m.ASSETS['solana'])]

    def capture(self):
        return self.m.AdbDiagnostics(self.root/'evidence', self.root/'assets')

    def report(self):
        path = self.root/'evidence/adb-diagnostic.json'
        raw = path.read_bytes()
        self.assertLessEqual(len(raw), 256*1024)
        value = json.loads(raw)
        for record in value['records']:
            for stream in ('stdout', 'stderr'):
                self.assertLessEqual(len(record[stream].encode('utf-8')), 16*1024)
        return value

    def test_exact_context_only_no_arbitrary_branch(self):
        self.m.assert_context(self.env)
        for key in self.env:
            if key in ('GH_TOKEN', 'GITHUB_TOKEN'):
                continue
            with self.subTest(key=key), patch.dict(os.environ, {key: 'other'}):
                with self.assertRaises(ValueError):
                    self.capture()
        for branch in ('refs/heads/main', 'refs/heads/codex/other'):
            with patch.dict(os.environ, {'GITHUB_REF': branch}):
                with self.assertRaises(ValueError):
                    self.capture()

    def test_denied_tokens_never_start_capture_or_child(self):
        for key in ('GH_TOKEN', 'GITHUB_TOKEN'):
            with self.subTest(key=key), patch.dict(os.environ, {key: 'synthetic-secret'}), \
                 patch.object(self.m.subprocess, 'run') as child:
                with self.assertRaises(ValueError):
                    self.capture()
                child.assert_not_called()
        self.assertFalse((self.root/'evidence').exists())

    def test_denied_commands_do_not_execute_or_preserve(self):
        capture = self.capture()
        denied = [ ['adb', 'devices'], ['adb', '-s', 'physical-phone', 'shell', 'pm', 'list', 'packages'],
            ['gh', 'run', 'download', '123'], ['adb', '-s', self.m.SERIAL, 'shell', 'printenv'],
            ['adb', '-s', self.m.SERIAL, 'shell', 'dumpsys'],
            ['adb', '-s', self.m.SERIAL, 'install', '--no-streaming', 'https://invalid/token'],
            ['adb', '-s', self.m.SERIAL, 'install', '--no-streaming', str(self.root/'other.apk')],
            ['adb', '-s', self.m.SERIAL, 'shell', 'am', 'broadcast', '-d', 'file:///anything'] ]
        with patch.object(self.m.subprocess, 'run') as child:
            for command in denied:
                with self.subTest(command=command):
                    with self.assertRaises(ValueError):
                        capture.run(command)
            child.assert_not_called()
        self.assertFalse((self.root/'evidence').exists())

    def test_calledprocess_capture_before_runtimefailure_preserves_hard_failure(self):
        capture = self.capture()
        failure = subprocess.CalledProcessError(1, self.command,
            output=b'Performing Push Install\n', stderr=b'Failure [INSTALL_FAILED_TEST_ONLY]\n')
        with patch.object(self.m.subprocess, 'run', side_effect=failure) as child:
            with self.assertRaises(self.m.RuntimeFailure) as caught:
                capture.run(self.command, timeout=180, stage=self.m.Stage.RUNTIME)
        self.assertEqual((caught.exception.stage, caught.exception.reason, caught.exception.exit_code),
            (self.m.Stage.RUNTIME, self.m.Reason.TOOL_EXIT, 1))
        self.assertEqual(child.call_args.kwargs['timeout'], 180)
        record = self.report()['records'][0]
        self.assertEqual(record['command'], self.command)
        self.assertEqual(record['stage'], 'runtime')
        self.assertEqual(record['stdout'], failure.output.decode())
        self.assertEqual(record['stderr'], failure.stderr.decode())
        self.assertEqual(record['exitCode'], 1)

    def test_oversize_streams_and_total_json_are_bounded(self):
        capture = self.capture()
        airplane = ['adb', '-s', self.m.SERIAL, 'shell', 'settings', 'get', 'global', 'airplane_mode_on']
        network = ['adb', '-s', self.m.SERIAL, 'shell', 'dumpsys', 'connectivity', '--short']
        huge = b'\x00'*1000000
        with patch.object(self.m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, huge, huge)):
            for _ in range(20):
                for command in (airplane, network):
                    capture.run(command, stage=self.m.Stage.GUEST_OFFLINE)
        with patch.object(self.m.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, self.command, huge, huge)):
            with self.assertRaises(self.m.RuntimeFailure):
                capture.run(self.command)
        report = self.report()
        self.assertEqual(len(report['records']), 3)
        self.assertTrue(all(r['stdoutTruncated'] and r['stderrTruncated'] for r in report['records']))

    def test_offline_validation_retains_actual_last_airplane_and_raw_connectivity(self):
        capture = self.capture()
        live = b'Active default network: 100\nCurrent Networks:\n  actual WIFI\nNetwork Requests:\n'
        def child(args, **kwargs):
            output = b'1\n' if args[-1] == 'airplane_mode_on' else live
            return subprocess.CompletedProcess(args, 0, output, b'raw warning\n')
        def adb(*args, **kwargs):
            return capture.run(['adb', '-s', self.m.SERIAL, *args], **kwargs)
        with patch.object(self.m.subprocess, 'run', side_effect=child) as process, patch.object(self.m.time, 'sleep'):
            with self.assertRaises(self.m.RuntimeFailure) as caught:
                self.m.verify_guest_offline(adb)
        self.assertEqual((caught.exception.stage.value, caught.exception.reason.value), ('guest_offline', 'validation'))
        self.assertEqual(process.call_count, 20)
        records = self.report()['records']
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]['stdout'], '1\n')
        self.assertEqual(records[1]['stdout'], live.decode())
        self.assertTrue(all(r['stage'] == 'guest_offline' for r in records))

    def test_timeout_captures_partial_output_and_stays_failure(self):
        capture = self.capture()
        with patch.object(self.m.subprocess, 'run', side_effect=subprocess.TimeoutExpired(
                self.command, 180, output=b'partial', stderr=b'timed out')):
            with self.assertRaises(self.m.RuntimeFailure) as caught:
                capture.run(self.command, timeout=180)
        self.assertEqual(caught.exception.reason, self.m.Reason.TIMEOUT)
        record = self.report()['records'][0]
        self.assertEqual((record['stdout'], record['stderr'], record['reason']), ('partial', 'timed out', 'timeout'))

    def test_capture_write_failure_cannot_replace_actual_tool_failure(self):
        capture = self.capture()
        with patch.object(self.m.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, self.command, b'o', b'e')), \
             patch.object(Path, 'write_bytes', side_effect=OSError('disk full')):
            with self.assertRaises(self.m.RuntimeFailure) as caught:
                capture.run(self.command)
        self.assertEqual(caught.exception.exit_code, 1)

    def test_lifecycle_never_activates_before_isolation_api_abi_ram(self):
        for fault in ('source', 'devices', 'qemu', 'api', 'abi', 'ram', None):
            def run(args, *a, **kw):
                key = str(args[-1])
                if list(args) == ['adb', 'devices']:
                    return 'List of devices attached\n'+('phone' if fault == 'devices' else self.m.SERIAL)+'\tdevice\n'
                return {'ro.kernel.qemu': '0' if fault == 'qemu' else '1',
                    'ro.build.version.sdk': '23' if fault == 'api' else '24',
                    'ro.product.cpu.abilist': 'arm64-v8a' if fault == 'abi' else 'x86',
                    '/proc/meminfo': 'MemTotal: '+('6291456' if fault == 'ram' else '1048576')+' kB\n'}[key]
            with self.subTest(fault=fault), patch.object(self.m, 'validate_import', side_effect=ValueError() if fault == 'source' else None), \
                 patch.object(self.m, 'workflow_request', return_value={}), \
                 patch.object(self.m, 'verify_files', return_value=({}, {})), \
                 patch.object(self.m, 'run', side_effect=run), \
                 patch.object(self.m, 'AdbDiagnostics', side_effect=RuntimeError('activated')) as capture:
                with self.assertRaises(ValueError if fault else RuntimeError):
                    self.m.emulate(self.root/'assets', self.root/'evidence', 24, 'x86', self.root)
                self.assertEqual(capture.call_count, 0 if fault else 1)

    def test_main_lifecycle_keeps_raw_evidence_and_returns_one_for_both_failures(self):
        good = b'Active default network: none\nCurrent Networks:\n\nNetwork Requests:\n'
        for failure_kind in ('offline', 'install'):
            evidence = self.root/failure_kind
            def process(args, **kwargs):
                command = list(map(str, args))
                if command == ['adb', 'devices']:
                    output = b'List of devices attached\nemulator-5554\tdevice\n'
                elif command[0] == 'ffmpeg':
                    output = b''
                elif command[-1] in ('ro.kernel.qemu', 'ro.build.version.sdk', 'ro.product.cpu.abilist', '/proc/meminfo'):
                    output = {'ro.kernel.qemu': b'1', 'ro.build.version.sdk': b'24',
                        'ro.product.cpu.abilist': b'x86', '/proc/meminfo': b'MemTotal: 1048576 kB\n'}[command[-1]]
                elif command[-1] == 'airplane_mode_on' and 'get' in command:
                    output = b'1\n'
                elif command[-1] == '--short':
                    output = good.replace(b'none', b'100') if failure_kind == 'offline' else good
                elif command[3:5] == ['install', '--no-streaming']:
                    raise subprocess.CalledProcessError(1, command, b'Performing Push Install', b'ACTUAL fixture install stderr')
                else:
                    output = b''
                return subprocess.CompletedProcess(command, 0, output, b'')
            argv = [str(SCRIPT), 'run', '--directory', str(self.root/'assets'),
                    '--evidence', str(evidence), '--api', '24', '--arch', 'x86', '--build-tools', str(self.root)]
            with self.subTest(failure_kind=failure_kind), patch.object(sys, 'argv', argv), \
                 patch.object(self.m, 'workflow_request', return_value={}), \
                 patch.object(self.m, 'validate_import'), patch.object(self.m, 'verify_files', return_value=({}, {})), \
                 patch.object(self.m.subprocess, 'run', side_effect=process), patch.object(self.m.time, 'sleep'), \
                 contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(self.m.main(), 1)
            failure = json.loads((evidence/'runtime-failure.json').read_text())
            records = json.loads((evidence/'adb-diagnostic.json').read_text())['records']
            if failure_kind == 'offline':
                self.assertEqual((failure['stage'], failure['reason']), ('guest_offline', 'validation'))
                self.assertIn('Active default network: 100', records[-1]['stdout'])
            else:
                self.assertEqual((failure['stage'], failure['reason'], failure['exitCode']), ('runtime', 'tool_exit', 1))
                self.assertEqual(records[-1]['stderr'], 'ACTUAL fixture install stderr')
                self.assertEqual(records[-1]['command'], self.command)

    def test_workflow_guards_and_source_input_preserved(self):
        workflow = (ROOT/'.github/workflows/verify-final-android-runtime.yml').read_text()
        self.assertNotIn('refs/heads/main', workflow)
        self.assertEqual(workflow.count(BRANCH), 8)
        self.assertEqual(workflow.count("github.workflow_ref == '"+self.m.REPO+
            '/.github/workflows/verify-final-android-runtime.yml@'+BRANCH+"'"), 2)
        self.assertIn('EXPECTED_SOURCE_COMMIT: ${{ inputs.expected_source_commit }}', workflow)
        self.assertIn("GH_TOKEN: ''\n          GITHUB_TOKEN: ''", workflow)
        self.assertEqual(workflow.count('persist-credentials: false'), 2)
        self.assertIn('python3 -B tests/runtime-adb-diagnostics.test.py', workflow)
        self.assertNotIn('continue-on-error', workflow)

if __name__ == '__main__':
    unittest.main(verbosity=2)
