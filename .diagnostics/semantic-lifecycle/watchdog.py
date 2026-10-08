"""Actual subprocess deadlines, process-group termination, bounded single upload."""
import os,signal,subprocess,time
from pathlib import Path
def run_bounded(command,seconds,stdout_path,stderr_path,env=None):
 began=time.monotonic()
 with open(stdout_path,'wb') as out,open(stderr_path,'wb') as err:
  p=subprocess.Popen(command,stdout=out,stderr=err,env=env,start_new_session=True)
  timed_out=False
  try:p.wait(timeout=seconds)
  except subprocess.TimeoutExpired:
   timed_out=True;os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=1)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
 return {'pid':p.pid,'returncode':p.returncode,'timed_out':timed_out,'elapsed_seconds':time.monotonic()-began,'terminated_process_group':timed_out}
