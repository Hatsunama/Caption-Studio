"""GitHub contract-only runner. No HF API, LiteRT SDK install/import or model work."""
import hashlib,importlib.util,json,os,subprocess,sys,time,traceback,unittest,io
from pathlib import Path
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'evidence';OUT.mkdir(exist_ok=True)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(command,input=None):
 p=subprocess.run(command,input=input,capture_output=True,timeout=40)
 if p.returncode:raise RuntimeError(str(command[0])+' failed: '+p.stderr.decode(errors='replace'))
 return p
def main():
 if 'HF_TOKEN' in os.environ:raise RuntimeError('HF token must not be supplied to contract-only route')
 if importlib.util.find_spec('litert_lm') is not None:raise RuntimeError('SDK must not be installed for contract-only route')
 began=time.monotonic();manifest=json.loads((ROOT/'GITHUB_CHECK_BUNDLE.json').read_text())
 for name,h in manifest['files'].items():
  if sha((ROOT/name).read_bytes())!=h:raise RuntimeError('input hash mismatch '+name)
 gson=ROOT/'gson-2.13.2.jar'
 if sha(gson.read_bytes())!='dd0ce1b55a3ed2080cb70f9c655850cda86c206862310009dcb5e5c95265a5e0':raise RuntimeError('Gson SHA mismatch')
 classes=OUT/'classes';classes.mkdir(exist_ok=True)
 run(['javac','-encoding','UTF-8','-cp',str(gson),'-d',str(classes),str(ROOT/'ContractOracle.java'),str(ROOT/'source/TranslationText.java'),str(ROOT/'source/TranslationResponseSchema.java')])
 command=['java','-cp',str(classes)+':'+str(gson),'app.captionstudio.translation.ContractOracle']
 result=run(command,input=(ROOT/'JAVA_FIXTURES_ACTIVE.json').read_bytes());(OUT/'JAVA_ORACLE_RESULTS.json').write_bytes(result.stdout)
 whitelist=json.loads((ROOT/'TARGET_WHITELIST.json').read_text())
 labels=run(command+['--labels'],input=json.dumps(list(whitelist)+['ur']).encode());(OUT/'JAVA_LABEL_RESULTS.json').write_bytes(labels.stdout)
 (OUT/'JAVA_VERSION.txt').write_bytes(run(['java','-version']).stderr)
 os.environ['RUN_CODE_REVISION']=os.environ.get('GITHUB_SHA','contract-only-local-run')
 suite=unittest.defaultTestLoader.discover(str(ROOT),pattern='test_production_contract.py')
 stream=io.StringIO();r=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
 (OUT/'REGRESSION_RESULTS.txt').write_text(stream.getvalue());print(stream.getvalue())
 plan=json.loads((ROOT/'EXECUTION_PLAN.json').read_text())
 summary={'mode':'JVM_PYTHON_CONTRACT_ONLY','passed':r.wasSuccessful(),'tests_run':r.testsRun,'failures':len(r.failures),'errors':len(r.errors),'active_cases':45,'nonEnglish_targets':18,'planned_inference_outputs':90,'actual_inference_outputs':0,'java_fixtures':len(json.loads((ROOT/'JAVA_FIXTURES_ACTIVE.json').read_text())),'native_checks':'REUSED_UNCHANGED; NOT_EXECUTED_HERE','SDK_installed':False,'model_downloads':0,'inference_calls':0,'engines_created':0,'seconds':time.monotonic()-began,'references_sha256':plan['preserved_file_sha256']['SEMANTIC_REFERENCES.json']}
 (OUT/'SUMMARY.json').write_text(json.dumps(summary,indent=2))
 if not r.wasSuccessful():raise RuntimeError('contract tests failed')
if __name__=='__main__':
 try:main()
 except BaseException:
  (OUT/'ERROR.txt').write_text(traceback.format_exc());raise
 finally:
  hashes={str(p.relative_to(OUT)):sha(p.read_bytes()) for p in OUT.rglob('*') if p.is_file() and p.name!='OUTPUT_SHA256.json'}
  (OUT/'OUTPUT_SHA256.json').write_text(json.dumps({'files':hashes,'github_sha':os.environ.get('GITHUB_SHA'),'fixture_raw_only_not_inference':True},indent=2))
