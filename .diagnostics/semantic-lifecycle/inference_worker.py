"""Future inference entry point. Not invoked by test-only launcher."""
import json,os,sys,time,traceback
from pathlib import Path
import eval_core as e
def download_model(key,folder):
 spec=e.model_spec(key);e.require_approval(e.sha((e.ROOT/'CASES.json').read_bytes()))
 import requests
 path=Path(folder)/(key+'.litertlm');h=__import__('hashlib').sha256();n=0;began=time.monotonic()
 url='https://huggingface.co/'+spec['repo']+'/resolve/'+spec['revision']+'/'+spec['file']
 headers={'Authorization':'Bearer '+os.environ['HF_TOKEN']} if key=='H' else {}
 with requests.get(url,headers=headers,stream=True,timeout=(15,30)) as r:
  r.raise_for_status()
  with path.open('wb') as f:
   for b in r.iter_content(1024*1024):
    if time.monotonic()-began>480:raise TimeoutError('model download deadline')
    n+=len(b)
    if n>spec['bytes']:raise RuntimeError('model length exceeded')
    h.update(b);f.write(b)
 if n!=spec['bytes'] or h.hexdigest()!=spec['sha256']:raise RuntimeError('model byte/hash mismatch')
 e.save(Path(folder)/(key+'.model_verified.json'),{'model':spec,'observed_bytes':n,'observed_sha256':h.hexdigest(),'seconds':time.monotonic()-began})
 return path
def main():
 verify_pack()
 e.require_approval(e.sha((e.ROOT/'CASES.json').read_bytes()))
 from litert_lm.engine import Engine
 from litert_lm.interfaces import Backend
 all_cases=e.load(e.ROOT/'CASES.json')['cases'];plan=e.load(e.ROOT/'EXECUTION_PLAN.json')
 bycase={c['case_id']:c for c in all_cases};cases=[bycase[x] for x in plan['active_case_ids']]
 system=e.load(e.ROOT/'SYSTEM.json');schedule=e.load(e.ROOT/'EXECUTION_SCHEDULE.json')
 trials=[e.make_trial(c,k,system) for k in ('QJ','HJ') for c in cases]
 e.save(e.ROOT/'evidence/INFERENCE_PREFLIGHT.json',e.native_preflight(trials))
 folder=e.ROOT/'evidence';started=time.monotonic();byid={c['case_id']:c for c in cases}
 for key,condition in [('Q','QJ'),('H','HJ')]:
  engine=None
  try:
   model=download_model(key,folder)
   engine=Engine(str(model),backend=Backend.CPU(thread_count=4),max_num_tokens=4096,cache_dir=str(folder/(key+'_cache')),enable_benchmark=True)
   e.save(folder/(key+'.engine_created.json'),{'model':e.model_spec(key),'pointer_live':bool(engine._engine_ptr)})
   for id in schedule[condition]:
    if time.monotonic()-started>6600:raise TimeoutError('inference reserved upload margin')
    t=e.make_trial(byid[id],condition,system)
    c=engine.create_conversation(**e.conversation_kwargs(t))
    e.capture_and_close(c,t,folder)
  finally:
   if engine is not None:e.save(folder/(key+'.engine_close.json'),e.closed(engine,'engine'))

def verify_pack():
 import hashlib,unittest,io,signal
 manifest=e.load(e.ROOT/'CODE_SHA256.json')
 if os.environ.get('APPROVED_RUN_PACK_SHA256')!=e.sha((e.ROOT/'CODE_SHA256.json').read_bytes()):
  raise RuntimeError('exact reviewed inference pack approval required')
 if os.environ.get('APPROVED_GREEN_ARTIFACT_SHA256')!='dbe0a383998a2adf40e069402909ca73eb76f2971eaf65423c359374b86ea5a9':
  raise RuntimeError('approved GREEN artifact linkage missing')
 for name,h in manifest['files'].items():
  if e.sha((e.ROOT/name).read_bytes())!=h:raise RuntimeError('pack hash mismatch '+name)
 e.require_approval(e.sha((e.ROOT/'CASES.json').read_bytes()))
 plan=e.load(e.ROOT/'EXECUTION_PLAN.json')
 for name,h in plan['preserved_file_sha256'].items():
  if e.sha((e.ROOT/name).read_bytes())!=h:raise RuntimeError('frozen input mismatch '+name)
 stream=io.StringIO()
 suite=unittest.defaultTestLoader.discover(str(e.ROOT),pattern='test_production_contract.py')
 result=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
 (e.ROOT/'evidence/RUNTIME_CONTRACT_TESTS.txt').write_text(stream.getvalue())
 if not result.wasSuccessful() or result.testsRun!=20:raise RuntimeError('runtime contract tests failed')
 def stop(signum,frame):raise SystemExit('cancellation signal '+str(signum))
 signal.signal(signal.SIGTERM,stop)
 e.save(e.ROOT/'evidence/APPROVAL_LINKAGE.json',{'pack_sha256':os.environ['APPROVED_RUN_PACK_SHA256'],'green_artifact_sha256':os.environ['APPROVED_GREEN_ARTIFACT_SHA256'],'code_revision':os.environ['RUN_CODE_REVISION'],'test_sha256':e.sha((e.ROOT/'test_production_contract.py').read_bytes()),'tests':20,'passed':True,'source_JVM_results':'unchanged compiled GREEN evidence, not recompiled here'})

if __name__=='__main__':main()
