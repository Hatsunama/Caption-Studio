import hashlib,io,json,os,sys,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'evidence';OUT.mkdir(exist_ok=True)
start=time.monotonic();suite=unittest.defaultTestLoader.discover(str(ROOT),pattern='test_launch_shell.py')
stream=io.StringIO();r=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
(OUT/'TEST_RESULTS.txt').write_text(stream.getvalue());print(stream.getvalue())
summary={'passed':r.wasSuccessful(),'tests':r.testsRun,'failures':len(r.failures),'errors':len(r.errors),'seconds':time.monotonic()-start,'commit':os.environ.get('GITHUB_SHA'),'mode':'MOCK_NATIVE_ONLY_NO_SDK_NO_MODEL','mocked_tools':['timeout','apt-get','uv'],'actual_checks':['sh -n','nested sh execution and argv','embedded Python compile and exact byte equality','actual AST bootstrap receipt-copy execution'],'source_sha256':{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in ['bootstrap.py','upload_evidence.py','runtime_setup.sh','LAUNCH_SETTINGS.json','test_launch_shell.py','LITERAL_SOURCE_DIFF.patch']}}
(OUT/'SUMMARY.json').write_text(json.dumps(summary,indent=2))
(OUT/'OUTPUT_SHA256.json').write_text(json.dumps({'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir() if p.is_file() and p.name!='OUTPUT_SHA256.json'}},indent=2))
sys.exit(0 if r.wasSuccessful() else 1)
