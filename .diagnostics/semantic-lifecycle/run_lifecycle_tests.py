import hashlib,io,json,os,sys,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'evidence';OUT.mkdir(exist_ok=True)
began=time.monotonic()
suite=unittest.defaultTestLoader.discover(str(ROOT),pattern='test_lifecycle.py')
stream=io.StringIO();r=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
log=stream.getvalue();print(log);(OUT/'TEST_RESULTS.txt').write_text(log)
summary={'tests':r.testsRun,'failures':len(r.failures),'errors':len(r.errors),'passed':r.wasSuccessful(),'seconds':time.monotonic()-began,'commit':os.environ.get('GITHUB_SHA'),'mode':'STOCK_PYTHON_LIFECYCLE_NO_SDK_NO_MODEL','test_sha256':hashlib.sha256((ROOT/'test_lifecycle.py').read_bytes()).hexdigest(),'source_sha256':{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in ['bootstrap.py','inference_worker.py','supervisor.py','watchdog.py','upload_evidence.py','EXECUTION_PLAN.json']}}
(OUT/'SUMMARY.json').write_text(json.dumps(summary,indent=2))
(OUT/'OUTPUT_SHA256.json').write_text(json.dumps({'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir() if p.is_file() and p.name!='OUTPUT_SHA256.json'}},indent=2))
sys.exit(0 if r.wasSuccessful() else 1)
