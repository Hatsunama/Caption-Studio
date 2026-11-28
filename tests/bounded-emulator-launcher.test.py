"""Focused host-only regressions: real child hangs, no SDK/device execution."""
import importlib.util
import contextlib
import json
from unittest import mock
import os
from pathlib import Path
import subprocess
import sys
import time
import tempfile
import unittest

PATH = Path(__file__).resolve().parents[1] / 'scripts/launch-runtime-emulator.py'
spec = importlib.util.spec_from_file_location('launcher', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def child(code):
    return [sys.executable, '-c', code]


class LauncherTests(unittest.TestCase):
    def test_rejected_context_has_failure_evidence_without_starting_tools(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.chdir(folder), \
             mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(m.sys, 'argv', ['launcher', '--api', '25', '--arch', 'x86_64']), \
             mock.patch.object(m, 'run_child') as run:
            self.assertEqual(m.main(), 1)
            run.assert_not_called()
            report = json.loads(Path('evidence/final-runtime/emulator-launch.json').read_text())
            self.assertEqual(report['events'][-1]['stage'], 'context-check')

    def test_failure_output_read_error_preserves_original_child_exit(self):
        class BrokenRead:
            def __init__(self):
                self.file = tempfile.TemporaryFile()
            def fileno(self): return self.file.fileno()
            def seek(self, *args): return self.file.seek(*args)
            def tell(self): return self.file.tell()
            def read(self, *args): raise OSError('evidence read failed')
            def close(self): self.file.close()
        broken = BrokenRead()
        with mock.patch.object(m.tempfile, 'TemporaryFile', return_value=broken), \
             self.assertRaises(subprocess.CalledProcessError) as caught:
            m.run_child(child('raise SystemExit(19)'), os.environ.copy(), 2, diagnostic=True)
        self.assertEqual(caught.exception.returncode, 19)

    def test_hung_unlock_child_has_finite_timeout(self):
        start = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired) as hung:
            m.run_child(child('import time; time.sleep(30)'), os.environ.copy(), .1)
        self.assertEqual(hung.exception.timeout, .1)
        self.assertLess(time.monotonic() - start, 3)

    def test_unlock_retries_only_timeout_and_is_finite(self):
        calls = []
        def adb(*args):
            calls.append(args)
            return m.run_child(child('import time; time.sleep(30)' if len(calls) < 3 else 'pass'), os.environ.copy(), .15)
        m.unlock(adb)
        self.assertEqual(len(calls), 3)
        calls.clear()
        def bad(*args):
            calls.append(args)
            return m.run_child(child('raise SystemExit(17)'), os.environ.copy(), 1)
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            m.unlock(bad)
        self.assertEqual(caught.exception.returncode, 17)
        self.assertEqual(len(calls), 1)
        with self.assertRaises(subprocess.TimeoutExpired):
            m.unlock(lambda *args: m.run_child(child('import time; time.sleep(30)'), os.environ.copy(), .15))

    def test_verifier_status_survives_cleanup_failure(self):
        p = subprocess.Popen(child('import time; time.sleep(30)'), start_new_session=(os.name == 'posix'))
        def verify():
            return m.run_child(child('raise SystemExit(23)'), os.environ.copy(), 1)
        def cleanup(proc):
            m.stop_group(proc)
            raise OSError('cleanup failed')
        try:
            self.assertEqual(m.lifecycle(p, verify, cleanup), (23, False))
            self.assertIsNotNone(p.poll())
        finally:
            if p.poll() is None:
                p.kill()
            p.wait()

    def test_cleanup_on_success_and_boot_failure(self):
        for fails in (False, True):
            p = subprocess.Popen(child('import time; time.sleep(30)'), start_new_session=(os.name == 'posix'))
            def verify():
                if fails:
                    raise TimeoutError('boot deadline')
            try:
                self.assertEqual(m.lifecycle(p, verify, m.stop_group), (1 if fails else 0, True))
                self.assertIsNotNone(p.poll())
            finally:
                if p.poll() is None:
                    p.kill()
                p.wait()
        p = subprocess.Popen(child('pass'))
        p.wait()
        self.assertEqual(m.lifecycle(p, lambda: None, lambda proc: (_ for _ in ()).throw(OSError())), (1, False))

    def test_reject_foreign_devices_and_context(self):
        m.assert_devices('List of devices attached\n\n', False)
        m.assert_devices('List of devices attached\nemulator-5554\tdevice\n', True)
        for data, owned in [('List of devices attached\nphone\tdevice\n', False),
                            ('List of devices attached\nemulator-5554\toffline\n', False),
                            ('List of devices attached\nemulator-5556\tdevice\n', True),
                            ('List of devices attached\nemulator-5554\tdevice\nphone\tdevice\n', True)]:
            with self.assertRaises(ValueError):
                m.assert_devices(data, owned)
        self.assertEqual(m.CONTEXT.get('GITHUB_ACTIONS'), 'true')
        env = dict(m.CONTEXT, GH_TOKEN='', GITHUB_TOKEN='')
        m.assert_context(env)
        for key in list(m.CONTEXT) + ['GH_TOKEN', 'GITHUB_TOKEN']:
            bad = dict(env, **{key: 'foreign'})
            with self.assertRaises(ValueError):
                m.assert_context(bad)


    def test_boot_identity_input_order_and_actual_verifier_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            fake = Path(folder) / 'fake_adb.py'
            fake.write_text("""import os, sys
args = sys.argv[1:]
if args == ['devices']:
    print('List of devices attached\\n' + ('foreign' if os.environ.get('FOREIGN') else 'emulator-5554') + '\\tdevice')
else:
    assert args[:2] == ['-s', 'emulator-5554']
    if args[2:] == ['shell', 'getprop', 'ro.kernel.qemu']: print('1')
    elif args[2:] == ['shell', 'getprop', 'sys.boot_completed']: print('0' if os.environ.get('BOOTING') else '1')
    elif args[2:] == ['shell', 'service', 'check', 'input']: print('Service input: found')
    else: assert args[2:] in (['shell', 'input', 'keyevent', '82'], ['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '0'])
""")
            for mode in ('verifier-failure', 'foreign', 'boot-deadline'):
                foreign = mode == 'foreign'
                env = dict(os.environ, **m.CONTEXT, GH_TOKEN='', GITHUB_TOKEN='', ANDROID_SERIAL=m.SERIAL)
                if foreign:
                    env['FOREIGN'] = '1'
                if mode == 'boot-deadline':
                    env['BOOTING'] = '1'
                calls, events = [], []
                def runner(argv, env, timeout, **kwargs):
                    calls.append(argv)
                    if argv[0] == 'bash':
                        self.assertEqual(argv, ['bash', 'scripts/verify-android-native-compatibility-runtime.sh', '25', 'x86_64'])
                        return m.run_child(child('raise SystemExit(37)'), env, timeout, **kwargs)
                    self.assertLessEqual(timeout, 5)
                    return m.run_child([sys.executable, str(fake), *argv[1:]], env, timeout, **kwargs)
                process = subprocess.Popen(child('import time; time.sleep(30)'), start_new_session=(os.name == 'posix'))
                code, clean = m.lifecycle(process, lambda: m.boot_and_verify(process, env, 'fake-adb', '25', 'x86_64', events, boot_seconds=.5 if mode == 'boot-deadline' else 10, runner=runner), m.stop_group)
                self.assertEqual((code, clean), (37 if mode == 'verifier-failure' else 1, True))
                self.assertIsNotNone(process.poll())
                if foreign:
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(events, [])
                elif mode == 'boot-deadline':
                    self.assertEqual(events, [{'stage': 'qemu-identity-confirmed'}])
                else:
                    self.assertEqual([event['stage'] for event in events], ['qemu-identity-confirmed', 'boot-completed', 'input-service-ready', 'unlock-completed', 'verifier-started'])



    def test_missing_ndk_lifecycle_and_bounded_setup_failure_evidence(self):
        # Exercise main, real child IO/exit and temp SDK files; no real SDK/device.
        original_run, original_popen = m.run_child, subprocess.Popen
        for mode in ('missing', 'present', 'wrong-revision', 'wrong-package', 'install-failure', 'setup-failure'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve()
                (root / 'build-tools/36.0.0').mkdir(parents=True)
                (root / 'build-tools/36.0.0/source.properties').write_text('Pkg.Revision = 36.0.0\n')
                ndk = root / 'ndk/27.1.12297006'
                if mode in ('present', 'wrong-revision', 'wrong-package'):
                    ndk.mkdir(parents=True)
                    (ndk / 'source.properties').write_text('Pkg.Revision = ' + ('28.0.0' if mode == 'wrong-revision' else '27.1.12297006') + '\n')
                    (ndk / 'package.xml').write_text('<sdk-repository><localPackage path="' + ('ndk;28.0.0' if mode == 'wrong-package' else 'ndk;27.1.12297006') + '"/></sdk-repository>')
                before = {p.name: p.read_bytes() for p in ndk.glob('*')}
                fake = root / 'fake_sdk.py'
                fake.write_text("""import os, pathlib, sys
root = pathlib.Path(os.environ['RUNNER_TEMP'])
args = sys.argv[1:]
mode = os.environ['FAKE_MODE']
if '--licenses' in args and mode == 'setup-failure':
    print('SDK LICENSE FAILURE: public detail', file=sys.stderr)
    print('x' * 20000)
    print('PUBLIC-TAIL-SENTINEL', file=sys.stderr)
    raise SystemExit(19)
if 'ndk;27.1.12297006' in args:
    if mode == 'install-failure': raise SystemExit(29)
    ndk = root / 'ndk/27.1.12297006'
    ndk.mkdir(parents=True)
    (ndk / 'source.properties').write_text('Pkg.Revision = 27.1.12297006\\n')
    (ndk / 'package.xml').write_text('<sdk-repository><localPackage path="ndk;27.1.12297006"/></sdk-repository>')
if 'avdmanager' in args[0]:
    avd = pathlib.Path(os.environ['ANDROID_AVD_HOME']) / 'bounded-runtime.avd'
    avd.mkdir()
    (avd / 'config.ini').write_text('hw.cpu.ncore=1\\n')
if 'adb' in args[0]: print('List of devices attached')
""")
                calls, reached = [], []
                def runner(argv, env, timeout, **kwargs):
                    calls.append(argv)
                    if 'ndk;27.1.12297006' in argv:
                        self.assertLessEqual(timeout, 600)
                        self.assertEqual(kwargs['input_text'], 'y\n' * 100)
                        self.assertIn('--sdk_root=' + str(root), argv)
                    return original_run([sys.executable, str(fake), *argv], env, timeout, **kwargs)
                def popen(argv, **kwargs):
                    if argv[0] == str(root / 'emulator/emulator'):
                        argv = child('import time; time.sleep(30)')
                    return original_popen(argv, **kwargs)
                def verify(*args):
                    reached.append(True)
                    original_run(child('raise SystemExit(37)'), os.environ.copy(), 2)
                env = dict(os.environ, **m.CONTEXT, GH_TOKEN='', GITHUB_TOKEN='',
                           RUNNER_TEMP=str(root), FAKE_MODE=mode)
                for key in ('ANDROID_SERIAL', 'ADB_SERVER_SOCKET', 'ADB_SERVER_PORT', 'ANDROID_ADB_SERVER_PORT'):
                    env.pop(key, None)
                with contextlib.chdir(root), mock.patch.dict(os.environ, env, clear=True), \
                     mock.patch.object(m.sys, 'argv', ['launcher', '--api', '25', '--arch', 'x86_64']), \
                     mock.patch.object(m.sys, 'platform', 'linux'), mock.patch.object(m.os, 'access', return_value=True), \
                     mock.patch.object(m, 'resolve_tools', return_value=(root, root / 'cmdline-tools/latest/bin/sdkmanager')), \
                     mock.patch.object(m, 'run_child', side_effect=runner), mock.patch.object(m.subprocess, 'Popen', side_effect=popen), \
                     mock.patch.object(m, 'boot_and_verify', side_effect=verify):
                    code = m.main()
                expected = 37 if mode in ('missing', 'present') else 29 if mode == 'install-failure' else 19 if mode == 'setup-failure' else 1
                self.assertEqual(code, expected)
                report = json.loads((root / 'evidence/final-runtime/emulator-launch.json').read_text())
                if mode in ('missing', 'present'):
                    self.assertEqual(reached, [True])
                    self.assertTrue(report['hostCleanupSucceeded'])
                    installs = [argv for argv in calls if 'ndk;27.1.12297006' in argv]
                    self.assertEqual(len(installs), 1 if mode == 'missing' else 0)
                    if installs:
                        self.assertEqual(installs[0][-2:], ['--install', 'ndk;27.1.12297006'])
                    if mode == 'present':
                        self.assertEqual(before, {p.name: p.read_bytes() for p in ndk.glob('*')})
                else:
                    self.assertEqual(reached, [])
                if mode == 'install-failure':
                    self.assertEqual(report['events'][-1]['stage'], 'ndk-install')
                    self.assertEqual(report['events'][-1]['exit'], 29)
                if mode == 'setup-failure':
                    failure = report['events'][-1]
                    self.assertEqual(failure['stage'], 'sdk-licenses')
                    self.assertEqual(failure['exit'], 19)
                    self.assertIn('PUBLIC-TAIL-SENTINEL', failure['outputTail'])
                    self.assertLessEqual(len(failure['outputTail'].encode()), 16384)
                    self.assertNotIn('FAKE_MODE', json.dumps(report))


if __name__ == '__main__':
    unittest.main(verbosity=2)


