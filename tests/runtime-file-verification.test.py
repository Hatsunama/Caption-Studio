"""Offline behavioral regressions; no SDK, Java, ADB, or network is invoked."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, call, patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/verify-android-native-compatibility-runtime.py'
STAGES = ('solana_identity', 'solana_signature', 'play_identity',
          'play_signature', 'aab_signature')
LEAK = 'PRIVATE-command-output-https://invalid.example/?token=SECRET'


class FileVerification(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('file_verification_runtime', SCRIPT)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'original signed assets'
        self.directory.mkdir()
        self.tools = self.root / 'fake build tools'
        self.pins = {'apk': 'a' * 64, 'aab': 'b' * 64}
        (self.root / 'config').mkdir()
        self.write_json(self.root / 'config/product-contract.json', {
            'android': {'release': {'signingCertificateSha256': self.pins['apk']}}})
        self.write_json(self.root / 'config/local-signing-contract.json', {'roles': self.pins})
        self.request = {'expected_source_commit': 'c' * 40, 'source_tree': 'd' * 40}
        for role in ('solana', 'play', 'aab'):
            path = self.directory / self.m.ASSETS[role]
            path.write_bytes(('original signed bytes ' + role).encode())
            self.request[role + '_sha256'] = self.m.sha(path)
        self.receipt = dict(schemaVersion=1, repository=self.m.REPO,
            sourceCommit=self.request['expected_source_commit'], sourceTree=self.request['source_tree'],
            package=self.m.PACKAGE, versionCode=149, version='1.4.9', certificates=self.pins,
            payloads={'apk': {'sha256': self.request['solana_sha256']},
                      'aab': {'sha256': self.request['aab_sha256']}})
        receipt_file = self.directory / self.m.ASSETS['receipt']
        self.write_json(receipt_file, self.receipt)
        self.request['receipt_sha256'] = self.m.sha(receipt_file)
        self.write_json(self.directory / 'request.json', self.request)
        self.addCleanup(patch.stopall)
        patch.object(self.m, 'ROOT', self.root).start()
        # Guard against an accidental unmocked external process or HTTP request.
        patch.object(self.m.subprocess, 'run', side_effect=AssertionError('external process forbidden')).start()
        patch.object(self.m, 'http_open', side_effect=AssertionError('network forbidden')).start()
        self.derived = patch.object(self.m, 'assert_derived_payload').start()
        self.calls = []

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value), encoding='utf-8')

    def tool_kind(self, args):
        args = [str(arg) for arg in args]
        if args[0] == 'java' and '-jar' not in args:
            return 'aab_signature'
        self.assertIn(args[-1], [str(self.directory / self.m.ASSETS[r]) for r in ('solana', 'play')])
        role = 'solana' if args[-1] == str(self.directory / self.m.ASSETS['solana']) else 'play'
        if args[0] == str(self.tools / 'aapt'):
            return role + '_identity'
        self.assertEqual(args[0], 'java')
        self.assertEqual(args[4:6], ['-jar', str(self.tools / 'lib/apksigner.jar')])
        return role + '_signature'

    def tool_output(self, kind):
        if kind.endswith('_identity'):
            return (f"package: name='{self.m.PACKAGE}' versionCode='149' versionName='1.4.9'\n"
                    "sdkVersion:'24'\ntargetSdkVersion:'36'\n")
        if kind == 'aab_signature':
            return 'VERIFIED\n'
        pin = self.pins['apk' if kind.startswith('solana') else 'aab']
        return f'Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: {pin}\n'

    def execute(self, override=None):
        def mocked_run(args, *positional, **kwargs):
            kind = self.tool_kind(args)
            self.calls.append((kind, [str(a) for a in args], kwargs))
            if override:
                output = override(kind, args, positional, kwargs)
                if output is not None:
                    return output
            return self.tool_output(kind)
        with patch.object(self.m, 'run', side_effect=mocked_run):
            return self.m.verify_files(self.directory, self.tools)

    def assert_no_leak(self, error, captured):
        self.assertNotIn(LEAK, str(error) + repr(error) + captured)
        self.assertIsNone(error.__cause__)
        self.assertTrue(error.__suppress_context__)

    def check_tool_failure(self, target):
        original_run = self.m.run
        def fail(kind, args, positional, kwargs):
            if kind == target:
                with patch.object(self.m.subprocess, 'run', side_effect=subprocess.CalledProcessError(
                        137, [LEAK], output=LEAK.encode(), stderr=LEAK.encode())):
                    return original_run(args, *positional, **kwargs)
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(self.m.RuntimeFailure) as caught:
                self.execute(fail)
        error = caught.exception
        self.assertEqual(error.exit_code, 137)
        self.assertEqual(error.reason, self.m.Reason.TOOL_EXIT)
        self.assert_no_leak(error, stdout.getvalue() + stderr.getvalue())
        self.assertEqual(self.calls[-1][0], target)
        self.derived.assert_not_called()
        self.assertEqual(error.stage.value, target)
        self.assertEqual(error.stage, getattr(self.m.Stage, target.upper()))

    def check_explicit_run_stage(self, name):
        self.assertIn(name.upper(), self.m.Stage.__members__)
        stage = self.m.Stage[name.upper()]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), patch.object(
                self.m.subprocess, 'run', side_effect=subprocess.CalledProcessError(
                    137, [LEAK], output=LEAK.encode(), stderr=LEAK.encode())):
            with self.assertRaises(self.m.RuntimeFailure) as caught:
                self.m.run([LEAK], stage=stage)
        self.assertEqual((caught.exception.stage, caught.exception.exit_code), (stage, 137))
        self.assertEqual(caught.exception.reason, self.m.Reason.TOOL_EXIT)
        self.assert_no_leak(caught.exception, stdout.getvalue() + stderr.getvalue())

    def test_text_tool_output_normalizes_windows_lines_without_changing_binary(self):
        output = b'certificate: exact\r\nVerified: true\r\n'
        result = subprocess.CompletedProcess(['public-verifier'], 0, stdout=output, stderr=b'')
        with patch.object(self.m.subprocess, 'run', return_value=result):
            self.assertEqual(self.m.run(['public-verifier']), 'certificate: exact\nVerified: true\n')
            self.assertEqual(self.m.run(['public-verifier'], binary=True), output)

    def test_success_checks_all_original_files_and_derived_payload(self):
        self.assertEqual(self.execute(), (self.request, self.receipt))
        self.assertEqual([c[0] for c in self.calls], list(STAGES))
        self.derived.assert_called_once_with(self.directory / self.m.ASSETS['aab'],
                                             self.directory / self.m.ASSETS['play'])

    def test_apksigner_has_bounded_jvm_and_complete_original_file_verification(self):
        self.execute()
        signatures = [args for kind, args, _ in self.calls if kind in ('solana_signature', 'play_signature')]
        self.assertEqual(len(signatures), 2)
        for role, args in zip(('solana', 'play'), signatures):
            with self.subTest(role=role):
                for flag in ('-Xms16m', '-Xmx128m', '-XX:ActiveProcessorCount=1'):
                    self.assertEqual(args.count(flag), 1)
                self.assertEqual(args[-4:], ['verify', '--verbose', '--print-certs',
                                             str(self.directory / self.m.ASSETS[role])])

    def test_aab_java_remains_bounded_and_checks_full_original(self):
        self.execute()
        args = next(args for kind, args, _ in self.calls if kind == 'aab_signature')
        self.assertEqual(args, ['java', '-Xms16m', '-Xmx96m', '-XX:ActiveProcessorCount=1',
            str(self.root / 'scripts/verify-android-native-compatibility-runtime.java'),
            str(self.directory / self.m.ASSETS['aab']), self.pins['aab']])

    def test_signature_rejects_wrong_pin_missing_pin_and_false_v2_for_each_apk(self):
        for role in ('solana', 'play'):
            target = role + '_signature'
            good = self.tool_output(target)
            pin = self.pins['apk' if role == 'solana' else 'aab']
            for label, bad in (('wrong pin', good.replace(pin, 'e' * 64)),
                               ('missing pin', good.split('Signer #')[0]),
                               ('false v2', good.replace(': true', ': false'))):
                with self.subTest(role=role, corruption=label):
                    self.calls.clear()
                    self.derived.reset_mock()
                    def output(kind, args, positional, kwargs):
                        return bad if kind == target else None
                    with self.assertRaises((ValueError, self.m.RuntimeFailure)):
                        self.execute(output)
                    self.assertEqual(self.calls[-1][0], target)
                    self.derived.assert_not_called()

    def test_bad_derived_payload_propagates_instead_of_returning_success(self):
        failure = ValueError('payload mismatch')
        self.derived.side_effect = failure
        with self.assertRaises(ValueError) as caught:
            self.execute()
        self.assertIs(caught.exception, failure)
        self.derived.assert_called_once_with(self.directory / self.m.ASSETS['aab'],
                                             self.directory / self.m.ASSETS['play'])

    def test_emulator_settings_run_only_after_isolated_guest_checks(self):
        for fault in ('physical serial', 'not qemu', 'wrong api', 'wrong abi', None):
            with self.subTest(fault=fault):
                def guest(args, *positional, **kwargs):
                    args = [str(arg) for arg in args]
                    if args == ['adb', 'devices']:
                        return 'List of devices attached\n' + ('real-phone' if fault == 'physical serial' else self.m.SERIAL) + '\tdevice\n'
                    if args[-1] == 'ro.kernel.qemu':
                        return '0' if fault == 'not qemu' else '1'
                    if args[-1] == 'ro.build.version.sdk':
                        return '23' if fault == 'wrong api' else '24'
                    if args[-1] == 'ro.product.cpu.abilist':
                        return 'arm64-v8a' if fault == 'wrong abi' else 'x86'
                    if args[-1] == '/proc/meminfo':
                        return 'MemTotal: 1048576 kB\n'
                    self.fail('Unexpected command before isolation was established')
                sentinel = RuntimeError('stop before media or app actions')
                with patch.dict(self.m.os.environ, {}, clear=True), \
                     patch.object(self.m, 'assert_context'), \
                     patch.object(self.m, 'validate_import'), \
                     patch.object(self.m, 'workflow_request', return_value={}), \
                     patch.object(self.m, 'verify_files', return_value=({}, {})), \
                     patch.object(self.m, 'run', side_effect=guest), \
                     patch.object(self.m, 'configure_emulator', side_effect=sentinel) as configure:
                    if fault:
                        with self.assertRaises(ValueError):
                            self.m.emulate(self.directory, self.root / 'evidence', 24, 'x86', self.tools)
                        configure.assert_not_called()
                    else:
                        with self.assertRaises(RuntimeError) as caught:
                            self.m.emulate(self.directory, self.root / 'evidence', 24, 'x86', self.tools)
                        self.assertIs(caught.exception, sentinel)
                        configure.assert_called_once()

    def test_fixture_preparation_stops_on_each_failure_and_requires_offline_proof(self):
        video = self.root / 'owned tiny.mp4'
        expected = [
            ('push', video, '/sdcard/Download/ci-tiny.mp4'),
            ('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file:///sdcard/Download/ci-tiny.mp4'),
            ('shell', 'settings', 'put', 'global', 'airplane_mode_radios', 'cell,bluetooth,wifi,nfc,wimax'),
            ('shell', 'settings', 'put', 'global', 'airplane_mode_toggleable_radios', 'none'),
            ('shell', 'settings', 'put', 'global', 'airplane_mode_on', '1'),
            ('shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', 'true')]
        stages = ('media_push', 'media_scan', 'airplane_setting', 'airplane_setting',
                  'airplane_setting', 'airplane_broadcast')
        calls = []
        def success(*args, **kwargs):
            calls.append((args, kwargs))
            return ''
        with patch.object(self.m, 'verify_guest_offline') as verify:
            self.m.prepare_fixture_for_import(success, video)
            verify.assert_called_once_with(success)
        self.assertEqual([args for args, _ in calls], expected)
        self.assertEqual([kwargs['stage'].value for _, kwargs in calls], list(stages))
        for failed_index in range(len(stages)):
            calls.clear()
            def fail(*args, **kwargs):
                calls.append((args, kwargs))
                if len(calls) == failed_index + 1:
                    raise self.m.RuntimeFailure(kwargs['stage'], self.m.Reason.TOOL_EXIT, exit_code=137)
                return ''
            with self.subTest(failed=failed_index), patch.object(self.m, 'verify_guest_offline') as verify:
                with self.assertRaises(self.m.RuntimeFailure) as caught:
                    self.m.prepare_fixture_for_import(fail, video)
                verify.assert_not_called()
            self.assertEqual(caught.exception.stage.value, stages[failed_index])
            self.assertEqual(caught.exception.exit_code, 137)
            self.assertEqual(len(calls), failed_index + 1)

    def test_offline_check_rejects_live_unknown_truncated_and_duplicate_network_state(self):
        valid = 'NetworkFactories for: WIFI\n\nActive default network: none\n\nCurrent Networks:\n\nNetwork Requests:\n  request data\n'
        self.assertTrue(self.m.guest_network_is_offline(valid))
        bad = [valid.replace('none', '100'),
               valid.replace('Current Networks:\n', 'Current Networks:\n  NetworkAgentInfo WIFI connected\n'),
               valid.replace('Current Networks:', 'Unexpected schema:'),
               valid.split('Network Requests:')[0],
               valid + 'Active default network: 100\n', '', 'x' * 1048577]
        for value in bad:
            with self.subTest(value=value[:60]):
                self.assertFalse(self.m.guest_network_is_offline(value))

    def test_offline_wait_requires_airplane_and_actual_network_disconnection(self):
        good = 'Active default network: none\nCurrent Networks:\n\nNetwork Requests:\n'
        live = good.replace('none', '100')
        snapshots = iter([live, good])
        calls = []
        def adb(*args, **kwargs):
            calls.append((args, kwargs))
            if args[-1] == 'airplane_mode_on':
                return '1\n'
            return next(snapshots)
        with patch.object(self.m.time, 'sleep') as sleep:
            self.m.verify_guest_offline(adb)
            sleep.assert_called_once_with(1)
        self.assertTrue(all(kwargs == {'timeout': 5, 'stage': self.m.Stage.GUEST_OFFLINE} for _, kwargs in calls))
        self.assertEqual(calls[0][0], ('shell', 'settings', 'get', 'global', 'airplane_mode_on'))
        self.assertEqual(calls[1][0], ('shell', 'dumpsys', 'connectivity', '--short'))
        for airplane in ('0', 'null', '1'):
            def never(*args, **kwargs):
                return airplane if args[-1] == 'airplane_mode_on' else live
            with self.subTest(airplane=airplane), patch.object(self.m.time, 'sleep') as sleep:
                with self.assertRaises(self.m.RuntimeFailure) as caught:
                    self.m.verify_guest_offline(never)
                self.assertEqual(caught.exception.stage, self.m.Stage.GUEST_OFFLINE)
                self.assertEqual(caught.exception.reason, self.m.Reason.VALIDATION)
                self.assertLessEqual(sleep.call_count, 9)

    def test_failure_evidence_never_reads_a_physical_or_ambiguous_target(self):
        for devices in ('List of devices attached\nreal-phone\tdevice\n',
                        'List of devices attached\nemulator-5554\tdevice\nreal-phone\tdevice\n'):
            with self.subTest(devices=devices), patch.object(self.m, 'run', return_value=devices) as run:
                self.assertFalse(self.m.collect_emulator_failure(self.root / 'diagnostic'))
                self.assertEqual(run.call_count, 1)
        with patch.object(self.m, 'run', side_effect=['List of devices attached\nemulator-5554\tdevice\n', '0']) as run:
            self.assertFalse(self.m.collect_emulator_failure(self.root / 'diagnostic'))
            self.assertEqual(run.call_count, 2)

    def test_failure_evidence_is_read_only_bounded_and_cannot_replace_original_failure(self):
        log = 'FATAL TEST FIXTURE\n'
        replies = ['List of devices attached\nemulator-5554\tdevice\n', '1', log]
        with patch.object(self.m, 'run', side_effect=replies) as run:
            self.assertTrue(self.m.collect_emulator_failure(self.root / 'diagnostic'))
            self.assertEqual([list(c.args[0]) for c in run.call_args_list], [
                ['adb', 'devices'], ['adb', '-s', 'emulator-5554', 'shell', 'getprop', 'ro.kernel.qemu'],
                ['adb', '-s', 'emulator-5554', 'logcat', '-d', '-b', 'crash', '-t', '80']])
            self.assertTrue(all(c.kwargs.get('timeout') == 5 for c in run.call_args_list))
        self.assertEqual((self.root / 'diagnostic/emulator-crash-log.txt').read_text(), log)
        with patch.object(self.m, 'run', side_effect=RuntimeError(LEAK)):
            self.assertFalse(self.m.collect_emulator_failure(self.root / 'diagnostic'))

    def test_configure_emulator_uses_four_bounded_settings_calls(self):
        self.assertTrue(callable(getattr(self.m, 'configure_emulator', None)), 'export configure_emulator(adb)')
        adb = Mock(return_value='')
        self.m.configure_emulator(adb)
        self.assertEqual(adb.call_args_list, [
            call('shell', 'settings', 'put', 'global', 'window_animation_scale', '0.0', timeout=10),
            call('shell', 'settings', 'put', 'global', 'transition_animation_scale', '0.0', timeout=10),
            call('shell', 'settings', 'put', 'global', 'animator_duration_scale', '0.0', timeout=10),
            call('shell', 'settings', 'put', 'secure', 'spell_checker_enabled', '0', timeout=10)])

    def test_configure_emulator_propagates_each_failure_without_continuing(self):
        self.assertTrue(callable(getattr(self.m, 'configure_emulator', None)), 'export configure_emulator(adb)')
        for index in range(4):
            with self.subTest(failed_call=index):
                failure = self.m.RuntimeFailure(self.m.Stage.RUNTIME, self.m.Reason.TIMEOUT)
                adb = Mock(side_effect=[''] * index + [failure])
                with self.assertRaises(self.m.RuntimeFailure) as caught:
                    self.m.configure_emulator(adb)
                self.assertIs(caught.exception, failure)
                self.assertEqual(adb.call_count, index + 1)


def failure_test(stage):
    def test(self):
        self.check_tool_failure(stage)
    return test


def run_stage_test(stage):
    def test(self):
        self.check_explicit_run_stage(stage)
    return test


for stage_name in STAGES:
    setattr(FileVerification, 'test_verify_files_exit_137_' + stage_name, failure_test(stage_name))
    setattr(FileVerification, 'test_run_preserves_explicit_stage_' + stage_name, run_stage_test(stage_name))


if __name__ == '__main__':
    unittest.main()
