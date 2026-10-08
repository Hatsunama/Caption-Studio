"""POSIX lifecycle regressions. Stock Python; no SDK, models or Hub calls."""
import contextlib,importlib.util,io,json,os,runpy,signal,subprocess,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('watchdog',ROOT/'watchdog.py')
watchdog=importlib.util.module_from_spec(spec);spec.loader.exec_module(watchdog)
PLAN=json.loads((ROOT/'EXECUTION_PLAN.json').read_bytes())
TIDS=[k+'_'+i for k in ['QJ','HJ'] for i in PLAN['active_case_ids']]
def bounded(code,seconds=2):
 with tempfile.TemporaryDirectory() as tmp:
  p=Path(tmp);r=watchdog.run_bounded([sys.executable,'-B','-c',code],seconds,p/'out',p/'err')
  return r,(p/'out').read_text(),(p/'err').read_text()
class Lifecycle(unittest.TestCase):
 def test_watchdog_success(self):
  r,out,err=bounded("print('SUCCESS')");self.assertEqual(r['returncode'],0);self.assertFalse(r['timed_out']);self.assertIn('SUCCESS',out)
 def test_watchdog_nonzero(self):
  r,out,err=bounded("import sys;print('FAIL_EVIDENCE',file=sys.stderr);sys.exit(7)")
  self.assertEqual(r['returncode'],7);self.assertFalse(r['timed_out']);self.assertIn('FAIL_EVIDENCE',err)
 def test_timeout_term_cleanup(self):
  code="import signal,time,sys\ndef stop(s,f):\n print('TERM_CLEANUP',flush=True);sys.exit(23)\nsignal.signal(signal.SIGTERM,stop)\nprint('READY',flush=True)\ntime.sleep(30)"
  r,out,err=bounded(code,.4);self.assertTrue(r['timed_out']);self.assertTrue(r['terminated_process_group']);self.assertEqual(r['returncode'],23);self.assertIn('TERM_CLEANUP',out)
 def test_timeout_ignoring_term_killed(self):
  r,out,err=bounded("import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('READY',flush=True);time.sleep(30)",.4)
  self.assertTrue(r['timed_out']);self.assertEqual(r['returncode'],-signal.SIGKILL);self.assertLess(r['elapsed_seconds'],4)
 def test_worker_error_evidence_upload_still_runs(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);(p/'evidence').mkdir()
   for n in ['supervisor.py','watchdog.py']:(p/n).write_bytes((ROOT/n).read_bytes())
   (p/'inference_worker.py').write_text("from pathlib import Path\nimport sys\np=Path(__file__).parent/'evidence'\n(p/'PRESERVED.raw.json').write_text('RAW_BEFORE_ERROR')\nprint('WORKER_ERROR',file=sys.stderr)\nsys.exit(3)\n")
   (p/'upload_evidence.py').write_text("from pathlib import Path\np=Path(__file__).parent/'evidence'\nassert (p/'PRESERVED.raw.json').read_text()=='RAW_BEFORE_ERROR'\nassert 'WORKER_ERROR' in (p/'WORKER_STDERR.txt').read_text()\n(p/'UPLOAD_PROOF.json').write_text('true')\n")
   env=dict(os.environ,RUN_MODE='inference')
   r=subprocess.run([sys.executable,'-B',str(p/'supervisor.py')],env=env,capture_output=True,timeout=10)
   self.assertEqual(r.returncode,1);self.assertTrue((p/'evidence/UPLOAD_PROOF.json').exists())
   self.assertEqual(json.loads((p/'evidence/WORKER_WATCHDOG.json').read_bytes())['returncode'],3)
 def test_bad_pack_approval_before_weights_or_sdk(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);(p/'CODE_SHA256.json').write_text('{"files":{}}')
   fake=types.ModuleType('eval_core');fake.ROOT=p
   fake.load=lambda path:json.loads(Path(path).read_bytes())
   import hashlib
   fake.sha=lambda b:hashlib.sha256(b).hexdigest()
   spec=importlib.util.spec_from_file_location('blocked_worker',ROOT/'inference_worker.py')
   w=importlib.util.module_from_spec(spec)
   with patch.dict(sys.modules,{'eval_core':fake}),patch.dict(os.environ,{'APPROVED_RUN_PACK_SHA256':'bad'}):
    spec.loader.exec_module(w)
    with patch.object(w,'download_model',side_effect=AssertionError('weights reached')) as download:
     with self.assertRaisesRegex(RuntimeError,'pack approval'):w.main()
     download.assert_not_called()
    self.assertNotIn('litert_lm',sys.modules)
 def upload(self,ids,wrong_trial=False,extra=False):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);(p/'evidence').mkdir()
   (p/'EXECUTION_PLAN.json').write_bytes((ROOT/'EXECUTION_PLAN.json').read_bytes())
   (p/'upload_evidence.py').write_bytes((ROOT/'upload_evidence.py').read_bytes())
   for tid in ids:
    (p/'evidence'/(tid+'.raw.json')).write_text(json.dumps({'trial':{'trial_id':'WRONG' if wrong_trial else tid},'raw_sdk_response':'UNIT_FIXTURE_NOT_MODEL'}))
   if extra:
    (p/'evidence'/'Q.litertlm').write_bytes(b'FORBIDDEN_MODEL')
    (p/'evidence'/'Q_cache').mkdir();(p/'evidence'/'Q_cache'/'cache.bin').write_bytes(b'FORBIDDEN_CACHE')
    (p/'evidence'/'RAW_ORDER_FIXTURE').mkdir();(p/'evidence'/'RAW_ORDER_FIXTURE'/'fake.raw.json').write_text('UNIT_ONLY')
   operations=[]
   class Add:
    def __init__(self,path_in_repo,path_or_fileobj):self.path_in_repo=path_in_repo;self.content=path_or_fileobj
   class API:
    def __init__(self,**kw):pass
    def create_commit(self,**kw):operations.extend(kw['operations']);return types.SimpleNamespace(oid='FAKE_UNIT_COMMIT')
   fake=types.ModuleType('huggingface_hub');fake.HfApi=API;fake.CommitOperationAdd=Add
   env={'HF_TOKEN':'UNIT_FAKE_NOT_SECRET','RUN_CODE_REVISION':'fixture','RUN_REPO':'fixture','RUN_BRANCH':'fixture','RUN_PREFIX':'fixture'}
   with patch.dict(sys.modules,{'huggingface_hub':fake}),patch.dict(os.environ,env),contextlib.redirect_stdout(io.StringIO()):
    runpy.run_path(str(p/'upload_evidence.py'),run_name='__main__')
   manifest=json.loads(next(x.content for x in operations if x.path_in_repo.endswith('/EVIDENCE_MANIFEST.json')))
   return manifest,operations
 def test_partial_evidence_counts(self):
  m,ops=self.upload(TIDS[:3]);self.assertEqual(m['observed_raw_envelopes'],3);self.assertFalse(m['completeness'])
 def test_wrong_ninety_filenames_not_complete(self):
  m,ops=self.upload(['WRONG_'+str(i) for i in range(90)]);self.assertFalse(m['completeness'])
 def test_wrong_embedded_trial_not_complete(self):
  m,ops=self.upload(TIDS,wrong_trial=True);self.assertFalse(m['completeness'])
 def test_complete_exact_ninety(self):
  m,ops=self.upload(TIDS);self.assertTrue(m['completeness']);self.assertEqual(m['observed_raw_envelopes'],90)
 def test_no_models_or_cache_uploads(self):
  m,ops=self.upload(TIDS[:1],extra=True)
  self.assertEqual(m['observed_raw_envelopes'],1)
  self.assertFalse(any(b'FORBIDDEN_MODEL' in x.content or b'FORBIDDEN_CACHE' in x.content for x in ops))
  self.assertTrue(any('/RAW_ORDER_FIXTURE/fake.raw.json' in x.path_in_repo for x in ops))
if __name__=='__main__':unittest.main(verbosity=2)
