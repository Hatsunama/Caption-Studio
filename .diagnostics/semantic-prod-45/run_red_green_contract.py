"""Contract-only RED/GREEN execution; no SDK or model."""
import hashlib,json,os,shutil,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def main():
 OUT.mkdir(exist_ok=True)
 began=time.monotonic()
 manifest=json.loads((ROOT/'GITHUB_CHECK_BUNDLE.json').read_bytes())
 receipt=json.loads((ROOT/'PACK_SHA256.json').read_bytes())
 for name,h in receipt['files'].items():
  if sha((ROOT/name).read_bytes())!=h:raise RuntimeError('publish hash mismatch '+name)
 for name in manifest['required_files']:
  if not (ROOT/name).is_file():raise RuntimeError('missing required evidence '+name)
 results={}
 for phase in ['RED','GREEN']:
  dst=OUT/phase;dst.mkdir()
  for name in manifest['required_files']:
   target=dst/name;target.parent.mkdir(parents=True,exist_ok=True)
   shutil.copyfile(ROOT/name,target)
  shutil.copyfile(ROOT/'gson-2.13.2.jar',dst/'gson-2.13.2.jar')
  if phase=='RED':
   p=dst/'eval_core.py';s=p.read_text()
   marker=" return {'trial_id':condition+'_'+case['case_id']"
   if s.count(marker)!=1:raise RuntimeError('RED mutation anchor mismatch')
   p.write_text(s.replace(marker," st['schema']=copy.deepcopy(SCHEMA) # TEST-ONLY rejected generic path reproducer\n"+marker))
   p=dst/'PAIR_SETTINGS.json';pair=json.loads(p.read_bytes())
   pair['app_source_revision']=pair['historical_app_source_revision'];p.write_text(json.dumps(pair,indent=2)+'\n')
  m=json.loads((dst/'GITHUB_CHECK_BUNDLE.json').read_bytes())
  m['phase']=phase;m['files']={n:sha((dst/n).read_bytes()) for n in m['files']}
  (dst/'GITHUB_CHECK_BUNDLE.json').write_text(json.dumps(m,indent=2)+'\n')
  input_hashes={n:sha((dst/n).read_bytes()) for n in m['required_files']}
  (dst/'PHASE_INPUT_SHA256.json').write_text(json.dumps(input_hashes,indent=2)+'\n')
  run=subprocess.run([sys.executable,'-B',str(dst/'github_contract_check.py')],capture_output=True,timeout=100)
  (dst/'STDOUT.txt').write_bytes(run.stdout);(dst/'STDERR.txt').write_bytes(run.stderr)
  summary=json.loads((dst/'evidence/SUMMARY.json').read_bytes())
  results[phase]={'returncode':run.returncode,'summary':summary,'test_sha256':input_hashes['test_production_contract.py']}
  if summary['errors']:raise RuntimeError(phase+' has infrastructure/test errors, not valid RED')
  if phase=='RED':
   log=(dst/'evidence/REGRESSION_RESULTS.txt').read_text()
   expected=['test_actual_45_paired_schema_and_scalar_identity','test_generic_schema_not_normal_path_and_strong_rejections','test_pair_metadata_current_production_source']
   if run.returncode==0 or summary['failures']!=3 or any('FAIL: '+n not in log for n in expected):
    raise RuntimeError('RED must reproduce exactly the three rejected-contract assertions')
  elif run.returncode or not summary['passed']:raise RuntimeError('GREEN contract failure')
 if results['RED']['test_sha256']!=results['GREEN']['test_sha256']:raise RuntimeError('tests differ')
 results.update({'mode':'CONTRACT_ONLY_NO_INFERENCE','seconds':time.monotonic()-began,'github_sha':os.environ.get('GITHUB_SHA'),'RED_provenance':'labelled prior generic schema/stale metadata reproducer; not current app','actual_model_outputs':0,'native_checks':'prior immutable evidence only; unchanged and not re-executed'})
 if not all(isinstance(results[k],dict) and 'summary' in results[k] for k in ['RED','GREEN']):raise RuntimeError('phase report overwritten')
 (OUT/'RED_GREEN_SUMMARY.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps(results))
if __name__=='__main__':
 try:main()
 finally:
  OUT.mkdir(exist_ok=True)
  (OUT/'ALL_OUTPUT_SHA256.json').write_text(json.dumps({'files':{str(p.relative_to(OUT)):sha(p.read_bytes()) for p in OUT.rglob('*') if p.is_file() and p.name!='ALL_OUTPUT_SHA256.json'}},indent=2)+'\n')
