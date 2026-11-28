import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/verify-android-native-compatibility-runtime.py'
spec = importlib.util.spec_from_file_location('runtime_log_boundary', SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

class LogBoundary(unittest.TestCase):
    def test_busy_global_log_buffer_does_not_prevent_scoped_capture(self):
        calls = []
        def adb(*args, **kwargs):
            calls.append((args, kwargs))
            if args == ('logcat', '-c'):
                raise runtime.RuntimeFailure(runtime.Stage.RUNTIME, runtime.Reason.TOOL_EXIT, exit_code=1)
            return ''
        marker = runtime.begin_log_capture(adb, 'solana')
        self.assertEqual(calls, [(('shell', 'log', '-p', 'i', '-t', 'CaptionStudioRuntime', marker), {'timeout': 10})])

    def test_capture_retains_current_crash_and_excludes_old_boot_crash(self):
        marker = 'CAPTION_STUDIO_QA_START_SOLANA'
        prefix = '11-28 02:00:00.000  123  124 I CaptionStudioRuntime: '
        current = '11-28 02:00:01.000  456  456 E AndroidRuntime: FATAL EXCEPTION: main\n'
        result = runtime.logs_since_marker('FATAL EXCEPTION: old boot\n'+prefix+marker+'\n'+current, marker)
        self.assertEqual(result, prefix+marker+'\n'+current)
        self.assertIn('FATAL EXCEPTION: main', result)

    def test_missing_duplicate_or_malformed_marker_is_a_hard_failure(self):
        marker = 'CAPTION_STUDIO_QA_START_PLAY'
        valid = '11-28 02:00:00.000  123  124 I CaptionStudioRuntime: '+marker+'\n'
        for logs in ('', 'E Other: '+marker+'\n', valid+valid, valid.replace(marker, marker+'EXTRA')):
            with self.subTest(logs=logs), self.assertRaises(ValueError):
                runtime.logs_since_marker(logs, marker)

    def test_marker_write_failure_is_not_ignored(self):
        failure = runtime.RuntimeFailure(runtime.Stage.RUNTIME, runtime.Reason.TOOL_EXIT, exit_code=1)
        def adb(*args, **kwargs):
            raise failure
        with self.assertRaises(runtime.RuntimeFailure) as caught:
            runtime.begin_log_capture(adb, 'play')
        self.assertIs(caught.exception, failure)

    def test_unrecognized_role_is_rejected_before_any_command(self):
        calls = []
        with self.assertRaises(ValueError):
            runtime.begin_log_capture(lambda *a, **k: calls.append(a), 'other')
        self.assertEqual(calls, [])

if __name__ == '__main__':
    unittest.main()
