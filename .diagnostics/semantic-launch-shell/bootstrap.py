import os,hashlib,json,tempfile,sys,runpy
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import requests
if os.environ.get('RUN_MODE')!='inference' or os.environ.get('APPROVED_RUN_PACK_SHA256')!=os.environ.get('CODE_MANIFEST_SHA256'):raise RuntimeError('exact inference pack approval required')
repo=os.environ['RUN_REPO'];rev=os.environ['RUN_CODE_REVISION'];prefix=os.environ['RUN_PREFIX']+'/code/'
headers={'Authorization':'Bearer '+os.environ['HF_TOKEN']}
def get(name):
 r=requests.get('https://huggingface.co/'+repo+'/resolve/'+rev+'/'+prefix+name,headers=headers,timeout=(15,30));r.raise_for_status();return r.content
b=get('CODE_SHA256.json')
if hashlib.sha256(b).hexdigest()!=os.environ['CODE_MANIFEST_SHA256']:raise RuntimeError('manifest hash mismatch')
manifest=json.loads(b);root=Path(tempfile.mkdtemp(prefix='coverage-test-only-'))
def fetch_file(item):
 name,expected=item
 if name.endswith('.litertlm') or name.startswith('/') or '..' in Path(name).parts:raise RuntimeError('artifact path prohibited')
 b=get(name)
 if hashlib.sha256(b).hexdigest()!=expected:raise RuntimeError('code/data hash mismatch '+name)
 path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b)
 print('PIN_VERIFIED '+name+' '+expected,flush=True)
with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(fetch_file,manifest['files'].items()))
(root/'CODE_SHA256.json').write_bytes(b);sys.path.insert(0,str(root))
os.environ['PYTHONPATH']=str(root);os.environ['PYTHONDONTWRITEBYTECODE']='1'
evidence=root/'evidence';evidence.mkdir(exist_ok=True)
for name in ['stdout','stderr','returncode']:
 source=Path('/tmp/semantic-native-setup.'+name)
 if not source.is_file():raise RuntimeError('native setup receipt absent')
 (evidence/('NATIVE_SETUP.'+name)).write_bytes(source.read_bytes())
if (evidence/'NATIVE_SETUP.returncode').read_text().strip()!='0':raise RuntimeError('native setup failed')
runpy.run_path(str(root/'supervisor.py'),run_name='__main__')
