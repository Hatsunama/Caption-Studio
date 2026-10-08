
"""One inference worker, one bounded evidence upload; no retry."""
import os,sys,json,time
from pathlib import Path
from watchdog import run_bounded
root=Path(__file__).resolve().parent;folder=root/'evidence';folder.mkdir(exist_ok=True)
if os.environ.get('RUN_MODE')!='inference':raise RuntimeError('inference mode required')
began=time.monotonic()
worker=run_bounded([sys.executable,'-B',str(root/'inference_worker.py')],6600,folder/'WORKER_STDOUT.txt',folder/'WORKER_STDERR.txt')
(folder/'WORKER_WATCHDOG.json').write_text(json.dumps(worker,indent=2))
upload=run_bounded([sys.executable,'-B',str(root/'upload_evidence.py')],120,folder/'UPLOAD_STDOUT.txt',folder/'UPLOAD_STDERR.txt')
print((folder/'UPLOAD_STDOUT.txt').read_text(),flush=True)
print((folder/'UPLOAD_STDERR.txt').read_text(),flush=True)
print('SUPERVISOR_FINAL '+json.dumps({'worker':worker,'upload':upload,'seconds':time.monotonic()-began,'single_worker':True,'single_upload':True}),flush=True)
if worker['returncode'] or worker['timed_out'] or upload['returncode'] or upload['timed_out']:sys.exit(1)
