"""Offline regression coverage: no GitHub, credentials, emulator, or build."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

HERE = Path(__file__).resolve().parent
SCRIPT = Path(os.environ.get('RUNTIME_SCRIPT_UNDER_TEST',
              str(HERE.parent/'scripts/verify-android-native-compatibility-runtime.py')))
SECRET = 'synthetic-secret-do-not-log'
LEAK = SECRET+' https://signed.invalid/?token='+SECRET+' Authorization: Bearer '+SECRET

class Response(io.BytesIO):
    status = 200

class Diagnostics(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('runtime', SCRIPT)
        self.m = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.m
        spec.loader.exec_module(self.m)
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(GITHUB_ACTIONS='true', GITHUB_EVENT_NAME='workflow_dispatch',
            GITHUB_REPOSITORY=self.m.REPO, GITHUB_REPOSITORY_OWNER='Hatsunama',
            GITHUB_ACTOR='Hatsunama', GITHUB_TRIGGERING_ACTOR='Hatsunama',
            GITHUB_REF='refs/heads/codex/final150-runtime-diagnostic', GITHUB_SHA='b'*40,
            GITHUB_WORKFLOW_REF=self.m.REPO+'/.github/workflows/verify-final-android-runtime.yml@refs/heads/codex/final150-runtime-diagnostic',
            GH_TOKEN=SECRET, RELEASE_ID='123', EXPECTED_SOURCE_COMMIT='a'*40)
        self.release = dict(id=123, draft=True, author={'login':'Hatsunama'},
                            target_commitish='a'*40, assets=[])
        for i, (role, name) in enumerate(self.m.ASSETS.items(), 1):
            self.env[role.upper()+'_ASSET_ID'] = str(i)
            digest = hashlib.sha256(role.encode()).hexdigest()
            self.env[role.upper()+'_SHA256'] = digest
            self.release['assets'].append(dict(id=i, name=name, state='uploaded',
                size=len(role), digest='sha256:'+digest))

    def http_error(self, status):
        return HTTPError('https://api.github.com/?'+LEAK, status, LEAK,
                         {'X-Secret': LEAK}, io.BytesIO(LEAK.encode()))

    def metadata(self):
        return [Response(json.dumps(self.release).encode()),
                Response(json.dumps(dict(sha='a'*40, commit={'tree':{'sha':'c'*40}})).encode()),
                Response(b'{"status":"ahead"}')]

    def invoke(self, effects, mode='download', error=None):
        evidence = self.root/'evidence'
        argv = [mode, '--directory', str(self.root/'assets'), '--evidence', str(evidence)]
        if mode == 'run':
            argv += ['--api','24','--arch','x86','--build-tools',str(self.root)]
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, 'argv', [str(SCRIPT), *argv]), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
             patch.object(self.m.subprocess, 'run', side_effect=OSError('Offline test: unexpected child process')), \
             patch.object(self.m, 'http_open', side_effect=effects, create=True) as opened, \
             patch.object(self.m.time, 'sleep') as sleep:
            try:
                if error is None:
                    code = self.m.main()
                else:
                    with patch.object(self.m, 'emulate', side_effect=error):
                        code = self.m.main()
            except Exception:
                raise AssertionError('Lifecycle did not return a sanitized failure record') from None
        self.assertEqual(code, 1)
        text = out.getvalue()+err.getvalue()
        self.assertNotIn(SECRET, text)
        self.assertNotIn('https://', text)
        record = json.loads((evidence/'runtime-failure.json').read_text())
        self.assertEqual(json.loads(err.getvalue()), record)
        self.assertEqual(record['mode'], mode)
        self.assertNotIn(SECRET, json.dumps(record))
        self.assertEqual(set(record), {'schemaVersion','status','mode','stage','reason','httpStatus','exitCode'})
        return record, opened, sleep

    def test_http_auth_not_found_forbidden_are_not_retried_at_each_operation(self):
        for status in (401, 404, 403):
            for prefix, stage in (([], 'release_metadata'),
                    (self.metadata()[:1], 'source_commit'),
                    (self.metadata()[:2], 'source_compare'),
                    (self.metadata(), 'asset_solana'),
                    (self.metadata()+[Response(b'solana')], 'asset_play'),
                    (self.metadata()+[Response(b'solana'), Response(b'play')], 'asset_aab'),
                    (self.metadata()+[Response(b'solana'), Response(b'play'), Response(b'aab')], 'asset_receipt')):
                with self.subTest(status=status, stage=stage):
                    # Each lifecycle exclusively owns a new output directory.
                    if (self.root/'assets').exists():
                        import shutil
                        shutil.rmtree(self.root/'assets')
                    record, opened, sleep = self.invoke(prefix+[self.http_error(status)])
                    self.assertEqual(record['stage'], stage)
                    self.assertEqual(record['reason'], 'http_error')
                    self.assertEqual(record['httpStatus'], status)
                    self.assertIsNone(record['exitCode'])
                    self.assertEqual(opened.call_count, len(prefix)+1)
                    sleep.assert_not_called()
                    self.assertFalse((self.root/'assets/request.json').exists())

    def test_transient_http_is_bounded_and_reports_final_status(self):
        for status in (429, 500, 502, 503, 504):
            with self.subTest(status=status):
                record, opened, sleep = self.invoke([self.http_error(status) for _ in range(3)])
                self.assertEqual((record['stage'], record['reason'], record['httpStatus']),
                                 ('release_metadata','http_error',status))
                self.assertEqual(opened.call_count, 3)
                self.assertEqual(sleep.call_count, 2)

    def test_transient_recovery_then_hash_verified_exact_files(self):
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(self.m.subprocess, 'run', side_effect=OSError('Offline test: unexpected child process')), \
             patch.object(self.m, 'http_open', side_effect=[self.http_error(503)]+self.metadata()+
                          [Response(r.encode()) for r in self.m.ASSETS], create=True), \
             patch.object(self.m.time, 'sleep') as sleep:
            self.m.download(self.root/'assets')
        request = json.loads((self.root/'assets/request.json').read_text())
        self.assertEqual(request['source_tree'], 'c'*40)
        for role, name in self.m.ASSETS.items():
            self.assertEqual(self.m.sha(self.root/'assets'/name), request[role+'_sha256'])
        sleep.assert_called_once_with(1)

    def test_timeout_and_transport_never_leak_error_or_token(self):
        for error, reason in ((TimeoutError(LEAK),'timeout'), (URLError(LEAK),'transport_error')):
            with self.subTest(reason=reason):
                record, opened, _ = self.invoke([error for _ in range(3)])
                self.assertEqual(record['reason'], reason)
                self.assertIsNone(record['httpStatus'])
                self.assertEqual(opened.call_count, 3)

    def test_hash_mismatch_never_produces_ready_marker(self):
        record, _, _ = self.invoke(self.metadata()+[Response(b'tampered')])
        self.assertEqual(record['stage'], 'asset_solana')
        self.assertEqual(record['reason'], 'validation')
        self.assertFalse((self.root/'assets/request.json').exists())

    def test_noncanonical_source_is_rejected_before_http(self):
        self.env['EXPECTED_SOURCE_COMMIT'] = '../'+LEAK
        record, opened, _ = self.invoke([])
        self.assertEqual(record['stage'], 'request')
        self.assertEqual(record['reason'], 'validation')
        opened.assert_not_called()

    def test_run_records_arbitrary_errors_without_free_text(self):
        for error in (ValueError(LEAK), RuntimeError(LEAK)):
            with self.subTest(kind=type(error).__name__):
                record, _, _ = self.invoke([], mode='run', error=error)
                self.assertEqual(record['stage'], 'runtime')
                self.assertIsNone(record['httpStatus'])

    def test_subprocess_exit_and_timeout_are_sanitized_and_preserve_code(self):
        cases = [(subprocess.CalledProcessError(7, [LEAK], output=LEAK.encode(), stderr=LEAK.encode()),
                  'tool_exit', 7),
                 (subprocess.TimeoutExpired([LEAK], 1, output=LEAK.encode(), stderr=LEAK.encode()),
                  'timeout', None),
                 (FileNotFoundError(LEAK), 'tool_missing', None)]
        for error, reason, code in cases:
            with self.subTest(reason=reason), patch.object(self.m.subprocess, 'run', side_effect=error):
                with self.assertRaises(self.m.RuntimeFailure) as caught:
                    self.m.run(['adb', LEAK])
                self.assertNotIn(SECRET, str(caught.exception))
                record, _, _ = self.invoke([], mode='run', error=caught.exception)
                self.assertEqual((record['stage'], record['reason'], record['exitCode']),
                                 ('tool', reason, code))

    def test_redirect_never_forwards_authentication_or_unsafe_destinations(self):
        redirect = self.m.AssetRedirect()
        req = Request('https://api.github.com/repos/x/y/releases/assets/1',
                      headers={'Authorization':'Bearer '+SECRET})
        redirected = redirect.redirect_request(req, None, 302, LEAK, {},
                            'https://release-assets.githubusercontent.com/asset?sig='+SECRET)
        self.assertFalse(any(k.lower() == 'authorization' for k in redirected.headers))
        for url in ('http://release-assets.githubusercontent.com/a',
                    'https://evil.invalid/a', 'https://api.github.com:444/a',
                    'https://user:pass@api.github.com/a'):
            with self.subTest(url=url), self.assertRaises(self.m.RuntimeFailure):
                redirect.redirect_request(req, None, 302, LEAK, {}, url)

    def test_workflow_download_writes_scoped_evidence_and_stays_readonly(self):
        workflow = (HERE.parent/'.github/workflows/verify-final-android-runtime.yml').read_text()
        command = next(l for l in workflow.splitlines() if 'runtime.py download --directory' in l)
        self.assertIn('--evidence evidence/final-runtime', command)
        runtime = workflow.split('  runtime:', 1)[1]
        self.assertNotIn('contents: write', runtime)
        self.assertIn('persist-credentials: false', workflow)
        self.assertIn('if: always()', workflow)
        self.assertIn('path: evidence/final-runtime/', workflow)

    def imported_fixture(self):
        root = self.root/'imported'
        root.mkdir()
        request = {k.lower(): v for k, v in self.env.items()
                   if k in ('RELEASE_ID','EXPECTED_SOURCE_COMMIT') or
                   any(k == r.upper()+suffix for r in self.m.ASSETS
                       for suffix in ('_ASSET_ID','_SHA256'))}
        request['source_tree'] = 'c'*40
        for role, name in self.m.ASSETS.items():
            (root/name).write_bytes(role.encode())
        (root/'request.json').write_text(json.dumps(request))
        return root, request

    def test_forged_and_stale_import_request_denied_before_hash_or_java(self):
        root, request = self.imported_fixture()
        fields = ['release_id','expected_source_commit'] + [
            r+suffix for r in self.m.ASSETS for suffix in ('_asset_id','_sha256')]
        with patch.dict(os.environ, self.env, clear=True):
            expected = self.m.workflow_request()
            for field in fields:
                with self.subTest(field=field), patch.object(self.m, 'sha') as hashed, \
                     patch.object(self.m, 'run') as executed:
                    stale = dict(request)
                    stale[field] = '9' if field.endswith('_id') else 'd'*len(request[field])
                    (root/'request.json').write_text(json.dumps(stale))
                    with self.assertRaises(self.m.RuntimeFailure):
                        self.m.validate_import(root, expected)
                    hashed.assert_not_called()
                    executed.assert_not_called()
            (root/'request.json').write_text(json.dumps(request))
            self.m.validate_import(root, expected)

    def test_import_rejects_noncanonical_files_and_links_before_hashing(self):
        root, _ = self.imported_fixture()
        with patch.dict(os.environ, self.env, clear=True):
            expected = self.m.workflow_request()
        for name in ('extra.key', 'nested'):
            target = root/name
            if name == 'nested': target.mkdir()
            else: target.write_bytes(b'forbidden')
            with self.subTest(name=name), patch.object(self.m, 'sha') as hashed:
                with self.assertRaises(self.m.RuntimeFailure): self.m.validate_import(root, expected)
                hashed.assert_not_called()
            if target.is_dir(): target.rmdir()
            else: target.unlink()
        asset = root/self.m.ASSETS['solana']
        asset.unlink()
        os.link(root/self.m.ASSETS['play'], asset)
        with patch.object(self.m, 'sha') as hashed:
            with self.assertRaises(self.m.RuntimeFailure): self.m.validate_import(root, expected)
            hashed.assert_not_called()
        asset.unlink()
        try:
            asset.symlink_to(root/self.m.ASSETS['play'])
        except OSError:
            self.skipTest('Windows host does not permit symlink creation; hardlink denial was exercised')
        with patch.object(self.m, 'sha') as hashed:
            with self.assertRaises(self.m.RuntimeFailure): self.m.validate_import(root, expected)
            hashed.assert_not_called()

    def test_imported_tree_independently_rechecked_against_public_source(self):
        for payload in (dict(sha='a'*40, commit={'tree':{'sha':'d'*40}}),
                        dict(sha='d'*40, commit={'tree':{'sha':'c'*40}})):
            with self.subTest(payload=payload), patch.dict(os.environ, self.env, clear=True), \
                 patch.object(self.m, 'http_open', return_value=Response(json.dumps(payload).encode()), create=True):
                request = dict(expected_source_commit='a'*40, source_tree='c'*40)
                with self.assertRaises(self.m.RuntimeFailure): self.m.validate_public_source(request)
        with patch.dict(os.environ, self.env, clear=True), patch.object(self.m, 'http_open',
                side_effect=[self.metadata()[1], Response(b'{"status":"diverged"}')], create=True):
            with self.assertRaises(self.m.RuntimeFailure):
                self.m.validate_public_source(dict(expected_source_commit='a'*40, source_tree='c'*40))

    def test_prepare_job_has_no_emulator_and_runtime_has_only_read_permissions(self):
        workflow = (HERE.parent/'.github/workflows/verify-final-android-runtime.yml').read_text()
        self.assertIn('  prepare:', workflow)
        prepare, runtime = workflow.split('  prepare:',1)[1].split('  runtime:',1)
        self.assertIn('contents: write', prepare)
        self.assertNotIn('reactivecircus/', prepare)
        self.assertNotIn('setup-node', prepare)
        self.assertNotIn('runtime.py run', prepare)
        self.assertIn('retention-days: 1', prepare)
        self.assertIn('if-no-files-found: error', prepare)
        self.assertIn('actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', prepare)
        self.assertIn('needs: prepare', runtime)
        self.assertIn('contents: read', runtime)
        self.assertIn('actions: read', runtime)
        self.assertNotIn('contents: write', runtime)
        self.assertIn('runtime.py receive', runtime)
        self.assertEqual(workflow.count('contents: write'), 1)
        for job in (prepare, runtime):
            self.assertIn("github.actor == 'Hatsunama'", job)
            self.assertIn("github.triggering_actor == 'Hatsunama'", job)
            self.assertIn("github.ref == 'refs/heads/codex/final150-runtime-diagnostic'", job)

    def test_receive_uses_only_same_run_fixed_name_and_rechecks_public_source(self):
        root, request = self.imported_fixture()
        self.env.update(GITHUB_RUN_ID='456', GITHUB_RUN_ATTEMPT='2', PREPARE_ARTIFACT_ID='789',
                        PREPARE_ARTIFACT_NAME='final-signed-inputs-456-2')
        artifact = dict(id=789, name='final-signed-inputs-456-2', expired=False,
                        workflow_run=dict(id=456, head_sha='b'*40))
        def downloaded(args, **kwargs):
            self.assertEqual([str(a) for a in args], ['gh','run','download','456',
                '--repo',self.m.REPO,'--name','final-signed-inputs-456-2',
                '--dir',str(self.root/'received')])
            self.assertEqual(kwargs['stage'], self.m.Stage.TRANSFER)
            for item in root.iterdir():
                (self.root/'received'/item.name).write_bytes(item.read_bytes())
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(self.m, 'http_open', side_effect=[Response(json.dumps(artifact).encode()),
                 self.metadata()[1], self.metadata()[2]]) as opened, \
             patch.object(self.m, 'run', side_effect=downloaded) as fetched:
            self.m.receive(self.root/'received')
            self.assertEqual(opened.call_count, 3)
            fetched.assert_called_once()
        for changed in (dict(id=790), dict(name='foreign'), dict(expired=True),
                        dict(workflow_run=dict(id=457, head_sha='b'*40)),
                        dict(workflow_run=dict(id=456, head_sha='c'*40))):
            with self.subTest(changed=changed), patch.dict(os.environ, self.env, clear=True), \
                 patch.object(self.m, 'http_open', return_value=Response(json.dumps({**artifact,**changed}).encode())), \
                 patch.object(self.m, 'run') as fetched:
                with self.assertRaises(self.m.RuntimeFailure): self.m.receive(self.root/'unused')
                fetched.assert_not_called()

    def test_receive_failure_gets_scoped_sanitized_evidence(self):
        self.env.update(GITHUB_RUN_ID='456', GITHUB_RUN_ATTEMPT='2', PREPARE_ARTIFACT_ID='789',
                        PREPARE_ARTIFACT_NAME='final-signed-inputs-456-2')
        record, _, _ = self.invoke([self.http_error(403)], mode='receive')
        self.assertEqual((record['stage'],record['httpStatus']), ('artifact_metadata',403))

    def test_symlink_stat_is_rejected_before_reading_metadata_or_hashing(self):
        root, _ = self.imported_fixture()
        original = Path.lstat
        def symlink_info(p, *args, **kwargs):
            if p.name == 'request.json':
                return os.stat_result((stat.S_IFLNK | 0o777,0,0,1,0,0,100,0,0,0))
            return original(p,*args,**kwargs)
        with patch.dict(os.environ, self.env, clear=True):
            expected = self.m.workflow_request()
        with patch.object(Path, 'lstat', symlink_info), patch.object(Path, 'read_text') as read, \
             patch.object(self.m, 'sha') as hashed:
            with self.assertRaises(self.m.RuntimeFailure): self.m.validate_import(root, expected)
            read.assert_not_called()
            hashed.assert_not_called()

    def test_partial_transfer_retry_truncates_old_bytes_and_keeps_exact_hash(self):
        class Partial(Response):
            def read(self, n=-1):
                if self.tell(): raise TimeoutError(LEAK)
                return super().read(3)
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(self.m, 'http_open', side_effect=self.metadata()+
                 [Partial(b'sol'), Response(b'solana'), Response(b'play'), Response(b'aab'), Response(b'receipt')]), \
             patch.object(self.m.time, 'sleep') as sleep:
            self.m.download(self.root/'assets')
        self.assertEqual((self.root/'assets'/self.m.ASSETS['solana']).read_bytes(), b'solana')
        sleep.assert_called_once_with(1)

    def test_successful_child_stderr_is_also_never_printed(self):
        out, err = io.StringIO(), io.StringIO()
        result = subprocess.CompletedProcess(['adb'], 0, b'ok', LEAK.encode())
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
             patch.object(self.m.subprocess, 'run', return_value=result):
            self.assertEqual(self.m.run(['adb']), 'ok')
        self.assertEqual(out.getvalue()+err.getvalue(), '')

    def test_emulate_rejects_stale_request_before_signature_tools(self):
        root, request = self.imported_fixture()
        request['release_id'] = '999'
        (root/'request.json').write_text(json.dumps(request))
        env = {k:v for k,v in self.env.items() if k != 'GH_TOKEN'}
        with patch.dict(os.environ, env, clear=True), \
             patch.object(self.m, 'verify_files', side_effect=ValueError('Offline stop before tools')) as verified:
            with self.assertRaises(Exception):
                self.m.emulate(root, self.root/'evidence', 24, 'x86', self.root)
            verified.assert_not_called()

    def test_emulate_rejects_symlink_before_signature_tools(self):
        root, _ = self.imported_fixture()
        env = {k:v for k,v in self.env.items() if k != 'GH_TOKEN'}
        original = Path.lstat
        def symlink_info(p, *args, **kwargs):
            if p.name == 'request.json':
                return os.stat_result((stat.S_IFLNK | 0o777,0,0,1,0,0,100,0,0,0))
            return original(p,*args,**kwargs)
        with patch.dict(os.environ, env, clear=True), patch.object(Path, 'lstat', symlink_info), \
             patch.object(self.m, 'verify_files', side_effect=ValueError('Offline stop before tools')) as verified:
            with self.assertRaises(Exception):
                self.m.emulate(root, self.root/'evidence', 24, 'x86', self.root)
            verified.assert_not_called()


    def receive_case(self, name, current='2', changes=None, mutation=None):
        root, request = self.imported_fixture()
        self.env.update(GITHUB_RUN_ID='456', GITHUB_RUN_ATTEMPT=current,
                        PREPARE_ARTIFACT_ID='789', PREPARE_ARTIFACT_NAME=name)
        artifact = dict(id=789, name=name, expired=False,
                        workflow_run=dict(id=456, head_sha='b'*40))
        artifact.update(changes or {})
        def downloaded(args, **kwargs):
            self.assertEqual([str(a) for a in args], ['gh','run','download','456',
                '--repo',self.m.REPO,'--name',name,'--dir',str(self.root/'received')])
            for item in root.iterdir():
                (self.root/'received'/item.name).write_bytes(item.read_bytes())
            if mutation: mutation(self.root/'received', request)
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(self.m, 'http_open', side_effect=[Response(json.dumps(artifact).encode()),
                 self.metadata()[1], self.metadata()[2]]) as opened, \
             patch.object(self.m, 'run', side_effect=downloaded) as fetched:
            self.m.receive(self.root/'received')
            self.assertEqual(opened.call_count, 3)
            fetched.assert_called_once()

    def test_lifecycle_same_attempt(self):
        self.receive_case('final-signed-inputs-456-2')

    def test_lifecycle_prior_prepare_attempt_recovery(self):
        self.receive_case('final-signed-inputs-456-1')

    def test_lifecycle_future_attempt_rejected_before_fetch(self):
        with patch.object(self.m, 'api_get') as metadata:
            with self.assertRaises(self.m.RuntimeFailure):
                self.receive_case('final-signed-inputs-456-3')
            metadata.assert_not_called()

    def test_lifecycle_noncanonical_or_foreign_name_rejected_before_fetch(self):
        for name in ('final-signed-inputs-457-1', 'final-signed-inputs-456-01',
                     'final-signed-inputs-456-0', 'final-signed-inputs-456-1/extra',
                     'final-signed-inputs-456-1\n', ''):
            with self.subTest(name=name):
                self.env.update(GITHUB_RUN_ID='456', GITHUB_RUN_ATTEMPT='2',
                    PREPARE_ARTIFACT_ID='789', PREPARE_ARTIFACT_NAME=name)
                with patch.dict(os.environ, self.env, clear=True), \
                     patch.object(self.m, 'api_get') as metadata, patch.object(self.m, 'run') as fetched:
                    with self.assertRaises(self.m.RuntimeFailure): self.m.receive(self.root/'unused')
                    metadata.assert_not_called()
                    fetched.assert_not_called()

    def test_lifecycle_prior_attempt_still_checks_id_run_head_and_name(self):
        for changes in (dict(id=790), dict(name='final-signed-inputs-456-2'),
                        dict(expired=True), dict(workflow_run=dict(id=457, head_sha='b'*40)),
                        dict(workflow_run=dict(id=456, head_sha='d'*40))):
            with self.subTest(changes=changes):
                # Each case needs a fresh fixture but no received directory is created.
                import shutil
                for folder in ('imported', 'received'):
                    if (self.root/folder).exists(): shutil.rmtree(self.root/folder)
                with self.assertRaises(self.m.RuntimeFailure):
                    self.receive_case('final-signed-inputs-456-1', changes=changes)
                self.assertFalse((self.root/'received').exists())

    def test_prepare_exports_producer_name_used_for_upload_and_receive(self):
        workflow = (HERE.parent/'.github/workflows/verify-final-android-runtime.yml').read_text()
        prepare, runtime = workflow.split('  prepare:',1)[1].split('  runtime:',1)
        self.assertIn('artifact_id: ${{ steps.signed_inputs.outputs.artifact-id }}', prepare)
        self.assertIn('artifact_name: ${{ steps.prepare_identity.outputs.artifact_name }}', prepare)
        self.assertIn('artifact_name=final-signed-inputs-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}', prepare)
        self.assertIn('name: ${{ steps.prepare_identity.outputs.artifact_name }}', prepare)
        self.assertIn('PREPARE_ARTIFACT_NAME: ${{ needs.prepare.outputs.artifact_name }}', runtime)

    def test_cancelled_partial_download_has_no_ready_marker(self):
        class Cancelled(Response):
            def read(self, n=-1):
                if self.tell(): raise KeyboardInterrupt()
                return super().read(3)
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(self.m, 'http_open', side_effect=self.metadata()+[Cancelled(b'solana')]), \
             patch.object(self.m.time, 'sleep') as sleep:
            with self.assertRaises(KeyboardInterrupt): self.m.download(self.root/'assets')
        self.assertFalse((self.root/'assets/request.json').exists())
        sleep.assert_not_called()

    def test_upload_lists_exact_five_sibling_files(self):
        workflow = (HERE.parent/'.github/workflows/verify-final-android-runtime.yml').read_text()
        transfer = workflow.split('        id: signed_inputs',1)[1].split('      - name:',1)[0]
        paths = transfer.split('          path: |',1)[1].split('          if-no-files-found:',1)[0]
        self.assertEqual({line.strip() for line in paths.splitlines() if line.strip()},
            {'${{ runner.temp }}/final-assets/'+n for n in (*self.m.ASSETS.values(), 'request.json')})
        self.assertIn('retention-days: 1', transfer)


    def test_prior_attempt_rejects_all_different_original_inputs_and_extra_file(self):
        fields = ['release_id', 'expected_source_commit'] + [
            r+suffix for r in self.m.ASSETS for suffix in ('_asset_id', '_sha256')]
        for field in fields + ['extra', 'source_tree', 'payload']:
            with self.subTest(field=field):
                import shutil
                for folder in ('imported', 'received'):
                    if (self.root/folder).exists(): shutil.rmtree(self.root/folder)
                def mutate(directory, request):
                    if field == 'extra': (directory/'extra').write_bytes(b'forbidden')
                    elif field == 'payload': (directory/self.m.ASSETS['play']).write_bytes(b'changed')
                    else:
                        changed = dict(request)
                        changed[field] = '999' if field.endswith('_id') else 'd'*len(request[field])
                        (directory/'request.json').write_text(json.dumps(changed))
                with self.assertRaises(self.m.RuntimeFailure):
                    self.receive_case('final-signed-inputs-456-1', mutation=mutate)

    def test_prior_attempt_rejects_link_before_hashing(self):
        original = Path.lstat
        def link_info(p, *args, **kwargs):
            if p.parent.name == 'received' and p.name == 'request.json':
                return os.stat_result((stat.S_IFLNK | 0o777,0,0,1,0,0,100,0,0,0))
            return original(p, *args, **kwargs)
        with patch.object(Path, 'lstat', link_info), patch.object(self.m, 'sha') as hashed:
            with self.assertRaises(self.m.RuntimeFailure):
                self.receive_case('final-signed-inputs-456-1')
            hashed.assert_not_called()

    def test_unredirected_auth_is_stripped_on_every_allowed_redirect(self):
        request = Request('https://api.github.com/repos/x/y/releases/assets/1')
        request.add_unredirected_header('Authorization', 'Bearer '+SECRET)
        redirect = self.m.AssetRedirect()
        for url in ('https://release-assets.githubusercontent.com/a?sig='+SECRET,
                    'https://objects.githubusercontent.com/b?sig='+SECRET,
                    'https://api.github.com/c'):
            request = redirect.redirect_request(request, None, 302, LEAK, {}, url)
            self.assertFalse(any(k.lower() == 'authorization' for k in request.header_items()))

    def test_exhausted_partial_download_is_not_ready_or_reused(self):
        class Partial(Response):
            def read(self, n=-1):
                if self.tell(): raise TimeoutError(LEAK)
                return super().read(3)
        record, opened, sleep = self.invoke(self.metadata()+[Partial(b'solana') for _ in range(3)])
        self.assertEqual((record['stage'], record['reason']), ('asset_solana', 'timeout'))
        self.assertFalse((self.root/'assets/request.json').exists())
        self.assertEqual(opened.call_count, 6)
        self.assertEqual(sleep.call_count, 2)
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(self.m, 'http_open', side_effect=self.metadata()) as opened:
            with self.assertRaises(FileExistsError): self.m.download(self.root/'assets')
            self.assertEqual(opened.call_count, 3)

if __name__ == '__main__':
    unittest.main()
