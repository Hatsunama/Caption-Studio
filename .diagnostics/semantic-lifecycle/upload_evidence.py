
"""One evidence upload. Model/cache binaries are never included."""
import hashlib,json,os
from pathlib import Path
from huggingface_hub import HfApi,CommitOperationAdd
def main():
 root=Path(__file__).resolve().parent;folder=root/'evidence'
 files={str(p.relative_to(folder)):p.read_bytes() for p in folder.rglob('*') if p.is_file() and p.suffix!='.litertlm' and not any(x.endswith('_cache') for x in p.relative_to(folder).parts) and p.name not in ('UPLOAD_STDOUT.txt','UPLOAD_STDERR.txt')}
 raw=sum(n.endswith('.raw.json') and '/' not in n for n in files)
 manifest={'code_revision':os.environ['RUN_CODE_REVISION'],'job_id':os.environ.get('HF_JOB_ID'),'run_mode':'inference','file_sha256':{k:hashlib.sha256(v).hexdigest() for k,v in files.items()},'single_upload_attempt':True,'observed_raw_envelopes':raw,'expected_raw_envelopes':90,'semantic_quality_certified':False,'completeness':raw==90}
 files['EVIDENCE_MANIFEST.json']=json.dumps(manifest,indent=2).encode()
 print('EVIDENCE_MANIFEST '+json.dumps(manifest),flush=True)
 commit=HfApi(token=os.environ['HF_TOKEN']).create_commit(repo_id=os.environ['RUN_REPO'],revision=os.environ['RUN_BRANCH'],parent_commit=os.environ['RUN_CODE_REVISION'],operations=[CommitOperationAdd(path_in_repo=os.environ['RUN_PREFIX']+'/evidence/'+k,path_or_fileobj=b) for k,b in files.items()],commit_message='Bounded inference evidence, raw envelopes retained including errors')
 print('EVIDENCE_COMMIT '+commit.oid,flush=True)
if __name__=='__main__':main()
