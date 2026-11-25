"""Offline installer contract: temporary SDKs only; never execute a real SDK tool.

Run with python -B tests/install-runtime-android-build-tools.test.py.
The resolver/main checks also run on Windows; executable fixtures require POSIX.
"""
import importlib.util
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'scripts/install-runtime-android-build-tools.py'
SECRET = 'synthetic-installer-secret-do-not-log'
RESOLUTION_ERRORS = (ValueError, RuntimeError, OSError, SystemExit)
POSIX_REASON = 'POSIX shebang fixtures cannot execute as native Windows programs'


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sdk installer ', dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.sdk = self.directory / 'selected SDK'
        self.sdk.mkdir()
        self.empty_path = self.directory / 'empty PATH'
        self.empty_path.mkdir()
        # Deliberately do not inherit SDK locations or credentials from the host.
        self.env = {'PATH': str(self.empty_path), 'GH_TOKEN': SECRET,
                    'GITHUB_TOKEN': SECRET, 'ANDROID_SDK_ROOT': str(self.sdk)}

    def manager(self, version='latest', sdk=None):
        manager = (sdk or self.sdk) / 'cmdline-tools' / version / 'bin/sdkmanager'
        manager.parent.mkdir(parents=True, exist_ok=True)
        manager.write_text('#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "$SDK_TEST_RECORD"\n'
                           'exit "${SDK_TEST_EXIT:-0}"\n', encoding='utf-8')
        manager.chmod(0o755)
        return manager.resolve()


class ResolverContract(Fixture):
    def setUp(self):
        super().setUp()
        # No import-time CLI execution or bytecode writes into the shared tree.
        spec = importlib.util.spec_from_file_location('runtime_build_tools_installer', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'dont_write_bytecode', True), \
             patch.object(subprocess, 'run', side_effect=AssertionError('import executed a tool')):
            spec.loader.exec_module(self.module)

    def resolve(self, env=None):
        # Resolution must not install anything or consult the ambient environment.
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(subprocess, 'run', side_effect=AssertionError('resolver executed a tool')):
            return self.module.resolve_sdkmanager(self.env if env is None else env)

    def assert_selected(self, manager, env=None):
        self.assertEqual(self.resolve(env), (self.sdk.resolve(), manager.resolve()))

    def test_latest_is_absolute_and_does_not_need_path(self):
        self.assert_selected(self.manager())

    def test_android_home_alone_is_authoritative(self):
        manager = self.manager()
        self.assert_selected(manager, {'ANDROID_HOME': str(self.sdk), 'PATH': ''})

    def test_equivalent_roots_are_not_a_conflict(self):
        manager = self.manager()
        self.assert_selected(manager, {**self.env,
                                      'ANDROID_HOME': str(self.sdk / '..' / self.sdk.name)})

    def test_latest_wins_over_multiple_versioned_managers(self):
        latest = self.manager()
        self.manager('12.0')
        self.manager('19.0')
        self.assert_selected(latest)

    def test_exactly_one_versioned_manager_when_latest_absent(self):
        self.assert_selected(self.manager('19.0'))

    def test_ambiguous_versions_fail_instead_of_picking_newest(self):
        self.manager('12.0')
        self.manager('19.0')
        with self.assertRaises(RESOLUTION_ERRORS):
            self.resolve()

    def test_existing_but_broken_latest_does_not_fall_back(self):
        (self.sdk / 'cmdline-tools/latest/bin').mkdir(parents=True)
        self.manager('19.0')
        with self.assertRaises(RESOLUTION_ERRORS):
            self.resolve()

    def test_conflicting_roots_rejected_even_when_both_have_managers(self):
        self.manager()
        other = self.directory / 'other SDK'
        self.manager(sdk=other)
        with self.assertRaises(RESOLUTION_ERRORS):
            self.resolve({**self.env, 'ANDROID_HOME': str(other)})

    def test_missing_root_does_not_fall_back_to_valid_home(self):
        self.manager()
        with self.assertRaises(RESOLUTION_ERRORS):
            self.resolve({**self.env, 'ANDROID_SDK_ROOT': str(self.directory / 'missing'),
                          'ANDROID_HOME': str(self.sdk)})

    def test_nonexistent_root_or_file_root_rejected(self):
        file_root = self.directory / 'file SDK'
        file_root.write_text('not a directory', encoding='utf-8')
        for root in (self.directory / 'missing', file_root):
            with self.subTest(root=root), self.assertRaises(RESOLUTION_ERRORS):
                self.resolve({**self.env, 'ANDROID_SDK_ROOT': str(root)})

    def test_missing_manager_and_directory_named_manager_rejected(self):
        with self.assertRaises(RESOLUTION_ERRORS):
            self.resolve()
        (self.sdk / 'cmdline-tools/latest/bin/sdkmanager').mkdir(parents=True)
        with self.assertRaises(RESOLUTION_ERRORS):
            self.resolve()

    def test_path_manager_cannot_replace_missing_authoritative_manager(self):
        decoy = self.manager(sdk=self.directory / 'decoy SDK')
        with self.assertRaises(RESOLUTION_ERRORS):
            self.resolve({**self.env, 'PATH': str(decoy.parent)})

    def test_no_configured_root_cannot_use_path_manager(self):
        decoy = self.manager()
        for env in ({'PATH': str(decoy.parent)},
                    {'PATH': str(decoy.parent), 'ANDROID_HOME': '', 'ANDROID_SDK_ROOT': ''}):
            with self.subTest(env=env), self.assertRaises(RESOLUTION_ERRORS):
                self.resolve(env)

    def test_main_invokes_exact_argument_vector_with_check_true(self):
        manager = self.manager()
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(sys, 'argv', [str(SCRIPT)]), \
             patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(self.module.main(), 0)
        run.assert_called_once()
        args, kwargs = run.call_args
        self.assertEqual(args, ([str(manager), '--sdk_root=' + str(self.sdk),
                                 'build-tools;36.0.0'],))
        self.assertIs(kwargs.get('check'), True)
        self.assertFalse(kwargs.get('shell', False))

    def test_main_preserves_selected_sdk_for_later_workflow_steps(self):
        self.manager()
        github_env = self.directory / 'github env'
        with patch.dict(os.environ, {**self.env, 'GITHUB_ENV': str(github_env)}, clear=True), \
             patch.object(sys, 'argv', [str(SCRIPT)]), \
             patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            self.assertEqual(self.module.main(), 0)
        self.assertEqual(github_env.read_text().splitlines(),
                         ['ANDROID_SDK_ROOT=' + str(self.sdk), 'ANDROID_HOME=' + str(self.sdk)])

    def test_main_cannot_report_success_after_child_failure(self):
        manager = self.manager()
        failure = subprocess.CalledProcessError(23, [str(manager)])
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(sys, 'argv', [str(SCRIPT)]), \
             patch.object(subprocess, 'run', side_effect=failure) as run, \
             contextlib.redirect_stdout(io.StringIO()) as out, \
             contextlib.redirect_stderr(io.StringIO()) as err:
            try:
                code = self.module.main()
            except subprocess.CalledProcessError as caught:
                self.assertEqual(caught.returncode, 23)
            except SystemExit as caught:
                self.assertIsInstance(caught.code, int)
                self.assertNotEqual(caught.code, 0)
            else:
                self.assertIsInstance(code, int)
                self.assertNotEqual(code, 0)
        run.assert_called_once()
        self.assertIs(run.call_args.kwargs.get('check'), True)
        self.assertNotIn(SECRET, out.getvalue() + err.getvalue())


@unittest.skipIf(os.name == 'nt', POSIX_REASON)
class ExecutableContract(Fixture):
    def invoke(self, env=None, argv=()):
        self.record = self.directory / 'invocation.txt'
        child_env = {**(self.env if env is None else env), 'SDK_TEST_RECORD': str(self.record)}
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), *argv],
                                env=child_env, cwd=self.directory, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=15, check=False)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        return result

    def assert_invocation(self, manager):
        self.assertEqual(self.record.read_text(encoding='utf-8').splitlines(),
                         [str(manager), '--sdk_root=' + str(self.sdk), 'build-tools;36.0.0'])

    def test_bare_command_is_missing_but_explicit_latest_executes(self):
        manager = self.manager()
        # Reproduce the original PATH-dependent failure without a real SDK.
        with self.assertRaises(FileNotFoundError):
            subprocess.run(['sdkmanager', 'build-tools;36.0.0'], env=self.env,
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=5, check=True)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_invocation(manager)

    def test_home_only_executes_unique_versioned_manager(self):
        manager = self.manager('19.0')
        env = {k: v for k, v in self.env.items() if k != 'ANDROID_SDK_ROOT'}
        result = self.invoke({**env, 'ANDROID_HOME': str(self.sdk)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_invocation(manager)

    def test_latest_executes_instead_of_versioned_or_path_decoys(self):
        manager = self.manager()
        self.manager('19.0')
        decoy = self.manager(sdk=self.directory / 'decoy SDK')
        result = self.invoke({**self.env, 'PATH': str(decoy.parent)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_invocation(manager)

    def test_sdkmanager_failure_makes_cli_nonzero(self):
        manager = self.manager()
        result = self.invoke({**self.env, 'SDK_TEST_EXIT': '23'})
        self.assertNotEqual(result.returncode, 0)
        self.assert_invocation(manager)

    def test_invalid_discovery_fails_before_any_manager_executes(self):
        decoy = self.manager(sdk=self.directory / 'decoy SDK')
        cases = [dict(self.env),
                 {**self.env, 'ANDROID_SDK_ROOT': str(self.directory / 'missing')},
                 {'PATH': str(decoy.parent)}]
        cases += [{**self.env, 'PATH': str(decoy.parent)}]
        for env in cases:
            with self.subTest(env=env):
                result = self.invoke(env)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.record.exists())

    def test_ambiguous_or_conflicting_roots_fail_without_execution(self):
        self.manager('12.0')
        self.manager('19.0')
        other = self.directory / 'other SDK'
        self.manager(sdk=other)
        for env in (self.env, {**self.env, 'ANDROID_HOME': str(other)}):
            with self.subTest(env=env):
                result = self.invoke(env)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.record.exists())

    def test_unexpected_cli_input_is_rejected_without_installing(self):
        self.manager()
        result = self.invoke(argv=('--sdk-root', str(self.sdk)))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.record.exists())


if __name__ == '__main__':
    unittest.main()
