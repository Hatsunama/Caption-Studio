"""Compile the actual helper against android-36 API classes, not host-JDK java.nio."""
import hashlib,json,os,pathlib,subprocess,sys
root=pathlib.Path.cwd()
stage=(root/'tests/receipt-compat-stage.txt').read_text().strip()
if stage not in ('RED','GREEN'):raise RuntimeError('explicit receipt compile stage required')
sdk=pathlib.Path(os.environ['ANDROID_HOME'])/'platforms/android-36/android.jar'
if not sdk.is_file():raise RuntimeError('actual Android API36 jar missing')
helper=root/'modules/caption-translation/android/src/test/java/app/captionstudio/translation/SerializationTestReceipt.java'
baseline=(root/'tests/receipt-android-api-baseline.java.txt').read_bytes()
prior=(root/'tests/receipt-expected-green.json').read_bytes()
work=root/'receipt-api-check';work.mkdir(exist_ok=True)
cp=os.pathsep.join(str(p) for p in [root/'test-classes',
 root/'modules/caption-translation/android/src/test/resources',sdk,
 *sorted((root/'test-jars').glob('*.jar'))])
report={'stage':stage,'head':os.environ.get('GITHUB_SHA'),
 'android_api':36,'android_jar_sha256':hashlib.sha256(sdk.read_bytes()).hexdigest(),
 'baseline_sha256':hashlib.sha256(baseline).hexdigest(),
 'current_helper_sha256':hashlib.sha256(helper.read_bytes()).hexdigest(),
 'behavior_tests_sha256':hashlib.sha256((helper.parent/'TranslationPromptSerializationTest.java').read_bytes()).hexdigest(),
 'classpath_scope':'Android36 bootclasspath; project/JUnit/Gson dependency classpath; Java8 bytecode probe, not an Android Gradle gate substitute',
 'checks':{}}
def invoke(name,args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=120)
 report['checks'][name]={'command':args,'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
 return p
try:
 for name,source in [('baseline',baseline),('current',helper.read_bytes())]:
  folder=work/name;folder.mkdir()
  path=folder/'SerializationTestReceipt.java';path.write_bytes(source)
  out=folder/'classes';out.mkdir()
  args=['javac','-encoding','UTF-8','-source','8','-target','8','-bootclasspath',str(sdk),
        '-classpath',cp,'-d',str(out),str(path)]
  p=invoke(name+'_android36_compile',args)
  if name=='baseline':
   if p.returncode==0:raise AssertionError('Regression did not reject the original helper')
   if 'cannot find symbol' not in p.stderr:raise RuntimeError('Baseline failed for an unrelated compiler/environment reason')
  elif stage=='RED':
   if p.returncode==0:raise AssertionError('Current broken helper unexpectedly compiles')
   if 'cannot find symbol' not in p.stderr:raise RuntimeError('RED failed for unrelated infrastructure')
  elif p.returncode:raise AssertionError('Fixed helper fails actual Android API compile')
 if stage=='GREEN':
  output=work/'current-receipt.json'
  p=invoke('execute_api_compiled_helper',['java','-cp',str(work/'current/classes')+os.pathsep+cp,
     'app.captionstudio.translation.SerializationTestReceipt','GREEN',str(output)])
  if p.returncode:raise AssertionError('API-compiled helper behavior failed')
  actual=output.read_bytes()
  if actual!=prior:raise AssertionError('JSON receipt bytes changed from preserved 867 GREEN')
  report['receipt_bytes_identical_to_867']=True
  report['receipt_sha256']=hashlib.sha256(actual).hexdigest()
 report['passed']=True
except Exception as e:
 report['passed']=False;report['error']={'type':type(e).__name__,'message':str(e)}
finally:
 (root/'receipt-android-api-results.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report),flush=True)
sys.exit(0 if report['passed'] else 1)
