"""Execute shell/argv and actual receipt-copy statements; no installs or inference."""
import ast,hashlib,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'evidence';OUT.mkdir(exist_ok=True)
BOOT=(ROOT/'bootstrap.py').read_bytes();SETUP=(ROOT/'runtime_setup.sh').read_bytes()
LAUNCH=json.loads((ROOT/'LAUNCH_SETTINGS.json').read_bytes())
class ShellProof(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.p=Path(self.tmp.name);self.bin=self.p/'bin';self.bin.mkdir()
  common="import os,sys,json,hashlib\nfrom pathlib import Path\nwith open(os.environ['MOCK_TRACE'],'a') as f:f.write(json.dumps({'tool':Path(sys.argv[0]).name,'argv':sys.argv[1:]})+'\\n')\n"
  scripts={
   'timeout':"a=sys.argv[1:]\nassert a[0]=='-k' and a[1]=='5s'\nassert a[2] in ('7170s','300s')\nos.execvp(a[3],a[3:])\n",
   'apt-get':"sys.exit(int(os.environ.get('MOCK_APT_RC','0')))\n",
   'uv':"a=sys.argv[1:]\ni=a.index('python')\nassert a[i+1:i+3]==['-B','-c']\nassert len(a)==i+4\nb=a[i+3].encode()\ncompile(b,'<embedded-bootstrap>','exec')\nPath(os.environ['MOCK_BOOT']).write_bytes(b)\n"
  }
  for n,s in scripts.items():
   p=self.bin/n;p.write_text('#!'+sys.executable+'\n'+common+s);p.chmod(0o755)
  self.env=dict(os.environ,PATH=str(self.bin)+':'+os.environ['PATH'],MOCK_TRACE=str(self.p/'trace'),MOCK_BOOT=str(self.p/'boot'))
  self.env.pop('HF_TOKEN',None)
  for suffix in ['stdout','stderr','returncode']:
   Path('/tmp/semantic-native-setup.'+suffix).unlink(missing_ok=True)
 def tearDown(self):
  for suffix in ['stdout','stderr','returncode']:
   Path('/tmp/semantic-native-setup.'+suffix).unlink(missing_ok=True)
  self.tmp.cleanup()
 def trace(self):
  return [json.loads(s) for s in (self.p/'trace').read_text().splitlines()]
 def record(self,name,r):
  data={'returncode':r.returncode,'stdout':r.stdout.decode(),'stderr':r.stderr.decode(),'trace':self.trace()}
  if (self.p/'boot').exists():data['embedded_python_sha256']=hashlib.sha256((self.p/'boot').read_bytes()).hexdigest()
  (OUT/name).write_text(json.dumps(data,indent=2))
 def test_shell_syntax_actual_command_and_setup(self):
  self.assertEqual(LAUNCH['command'][:2],['sh','-c'])
  for text in [LAUNCH['command'][2].encode(),SETUP]:
   r=subprocess.run(['sh','-n'],input=text,capture_output=True,timeout=5)
   self.assertEqual(r.returncode,0,r.stderr)
 def test_exact_argv_and_embedded_python_roundtrip(self):
  r=subprocess.run(LAUNCH['command'],env=self.env,capture_output=True,timeout=10)
  self.record('ARGV_ROUND_TRIP.json',r);self.assertEqual(r.returncode,0,r.stderr)
  t=self.trace()
  self.assertEqual([x['tool'] for x in t],['timeout','timeout','apt-get','apt-get','uv'])
  self.assertEqual(t[0]['argv'][:4],['-k','5s','7170s','sh'])
  self.assertEqual(t[1]['argv'],['-k','5s','300s','sh','-c','apt-get update -qq && apt-get install -y --no-install-recommends libvulkan1'])
  self.assertEqual(t[2]['argv'],['update','-qq'])
  self.assertEqual(t[3]['argv'],['install','-y','--no-install-recommends','libvulkan1'])
  expected=['run','--with','huggingface-hub==0.30.2','--with','lm-format-enforcer==0.11.3','--with','litert-lm-api==0.17.1','--with','requests==2.32.3','--with','jsonschema==4.23.0','python','-B','-c']
  self.assertEqual(t[4]['argv'][:-1],expected)
  self.assertEqual((self.p/'boot').read_bytes(),BOOT)
  self.assertEqual(Path('/tmp/semantic-native-setup.returncode').read_bytes(),b'0\n')
 def test_new_setup_script_actual_mocked_execution(self):
  r=subprocess.run(['sh',str(ROOT/'runtime_setup.sh')],env=self.env,capture_output=True,timeout=10)
  self.record('STANDALONE_SETUP.json',r);self.assertEqual(r.returncode,0,r.stderr)
  t=self.trace();self.assertEqual([x['tool'] for x in t],['timeout','apt-get','apt-get'])
  self.assertEqual(t[1]['argv'],['update','-qq']);self.assertEqual(t[2]['argv'],['install','-y','--no-install-recommends','libvulkan1'])
  self.assertEqual(Path('/tmp/semantic-native-setup.returncode').read_bytes(),b'0\n')
 def test_setup_failure_blocks_uv_and_python(self):
  env=dict(self.env,MOCK_APT_RC='37')
  r=subprocess.run(LAUNCH['command'],env=env,capture_output=True,timeout=10)
  self.record('SETUP_FAILURE.json',r);self.assertEqual(r.returncode,37)
  self.assertEqual([x['tool'] for x in self.trace()],['timeout','timeout','apt-get'])
  self.assertFalse((self.p/'boot').exists())
  self.assertEqual(Path('/tmp/semantic-native-setup.returncode').read_bytes(),b'37\n')
class ActualBootstrapReceipts(unittest.TestCase):
 def run_receipts(self,values):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);inputs=root/'inputs';inputs.mkdir()
   for n,b in values.items():(inputs/n).write_bytes(b)
   tree=ast.parse(BOOT)
   start=next(i for i,n in enumerate(tree.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='evidence' for t in n.targets))
   last=tree.body[-1]
   self.assertIsInstance(last,ast.Expr);self.assertIsInstance(last.value,ast.Call)
   self.assertEqual(ast.unparse(last.value.func),'runpy.run_path')
   code=compile(ast.Module(body=tree.body[start:-1],type_ignores=[]),'<actual-bootstrap-receipt-statements>','exec')
   def mapped(path):
    s=str(path);prefix='/tmp/semantic-native-setup.'
    return inputs/s[len(prefix):] if s.startswith(prefix) else Path(path)
   error=None
   try:exec(code,{'root':root,'Path':mapped})
   except RuntimeError as ex:error=str(ex)
   copied={p.name:p.read_bytes() for p in (root/'evidence').iterdir()}
   return error,copied
 def test_actual_receipt_copy_absent_fails(self):
  error,copied=self.run_receipts({})
  self.assertEqual(error,'native setup receipt absent');self.assertEqual(copied,{})
 def test_actual_receipt_copy_nonzero_preserved_then_fails(self):
  values={'stdout':b'actual fixture stdout\n','stderr':b'actual fixture stderr\n','returncode':b'37\n'}
  error,copied=self.run_receipts(values)
  self.assertEqual(error,'native setup failed')
  self.assertEqual(copied,{'NATIVE_SETUP.'+n:b for n,b in values.items()})
 def test_actual_receipt_copy_zero_exact_bytes(self):
  values={'stdout':b'actual fixture stdout\n','stderr':b'actual fixture stderr\n','returncode':b'0\n'}
  error,copied=self.run_receipts(values)
  self.assertIsNone(error);self.assertEqual(copied,{'NATIVE_SETUP.'+n:b for n,b in values.items()})
if __name__=='__main__':unittest.main(verbosity=2)
