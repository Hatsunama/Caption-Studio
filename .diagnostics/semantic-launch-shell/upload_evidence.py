
"""One evidence upload. Model/cache binaries are never included."""
import hashlib,json,os
from pathlib import Path
from huggingface_hub import HfApi,CommitOperationAdd
def main():
 root=Path(__file__).resolve().parent;folder=root/'evidence'
 files={str(p.relative_to(folder)):p.read_bytes() for p in folder.rglob('*') if p.is_file() and p.suffix!='.litertlm' and not any(x.endswith('_cache') for x in p.relative_to(folder).parts) and p.name not in ('UPLOAD_STDOUT.txt','UPLOAD_STDERR.txt')}
 plan=json.loads((root/'EXECUTION_PLAN.json').read_bytes())
 expected={k+'_'+i for k in ['QJ','HJ'] for i in plan['active_case_ids']}
 rawfiles={n[:-9]:b for n,b in files.items() if n.endswith('.raw.json') and '/' not in n}
 raw=len(rawfiles);invalid={}
 for tid,b in rawfiles.items():
  try:
   embedded=json.loads(b)['trial']['trial_id']
   if embedded!=tid:invalid[tid]='embedded trial ID mismatch'
  except (ValueError,KeyError,TypeError):invalid[tid]='raw trial metadata unreadable'
 complete=set(rawfiles)==expected and not invalid
 observed_counts={k:sum(t.startswith(k+'_') for t in rawfiles) for k in ['QJ','HJ']}
 expected_counts={k:len(plan['active_case_ids']) for k in ['QJ','HJ']}
 manifest={'code_revision':os.environ['RUN_CODE_REVISION'],'job_id':os.environ.get('HF_JOB_ID'),'run_mode':'inference','file_sha256':{k:hashlib.sha256(v).hexdigest() for k,v in files.items()},'single_upload_attempt':True,'observed_raw_envelopes':raw,'expected_raw_envelopes':len(expected),'semantic_quality_certified':False,'completeness':complete,'completeness_scope':'raw capture index only, not schema or meaning','expected_trial_ids':sorted(expected),'observed_trial_ids':sorted(rawfiles),'missing_trial_ids':sorted(expected-set(rawfiles)),'unexpected_trial_ids':sorted(set(rawfiles)-expected),'invalid_raw_trial_metadata':invalid,'observed_counts':observed_counts,'expected_counts':expected_counts}
 files['EVIDENCE_MANIFEST.json']=json.dumps(manifest,indent=2).encode()
 print('EVIDENCE_MANIFEST '+json.dumps(manifest),flush=True)
 commit=HfApi(token=os.environ['HF_TOKEN']).create_commit(repo_id=os.environ['RUN_REPO'],revision=os.environ['RUN_BRANCH'],parent_commit=os.environ['RUN_CODE_REVISION'],operations=[CommitOperationAdd(path_in_repo=os.environ['RUN_PREFIX']+'/evidence/'+k,path_or_fileobj=b) for k,b in files.items()],commit_message='Bounded inference evidence, raw envelopes retained including errors')
 print('EVIDENCE_COMMIT '+commit.oid,flush=True)
if __name__=='__main__':main()
