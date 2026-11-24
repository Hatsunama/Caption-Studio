import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root = process.env.CAPABILITY_SOURCE_ROOT
  ? path.resolve(process.env.CAPABILITY_SOURCE_ROOT) : fileURLToPath(new URL('../', import.meta.url));
const out = process.env.CAPABILITY_HARNESS_OUTPUT
  ? path.resolve(process.env.CAPABILITY_HARNESS_OUTPUT) : path.join(root, '.capability-native-harness');
const prefix = 'modules/caption-translation/android/src/main/java/app/captionstudio/translation/';
const pkg = 'app/captionstudio/translation/';
const read = (name) => readFileSync(existsSync(path.join(root, prefix, name))
  ? path.join(root, prefix, name) : path.join(process.env.CAPABILITY_BASELINE_ROOT ?? root, prefix, name), 'utf8');
const files = {
  'android/app/ActivityManager.java': 'package android.app; public class ActivityManager { public static long total=8L*1024*1024*1024; public static boolean low=false; public static class MemoryInfo { public long totalMem; } public void getMemoryInfo(MemoryInfo m){m.totalMem=total;} public boolean isLowRamDevice(){return low;} public int getMemoryClass(){return 512;} }',
  'android/content/Context.java': 'package android.content; import java.io.File; public class Context { public static final String ACTIVITY_SERVICE="activity"; public Context getApplicationContext(){return this;} public Object getSystemService(String s){return new android.app.ActivityManager();} public File getCacheDir(){return new File(".");} public File getNoBackupFilesDir(){return new File(".");} }',
  'android/os/Build.java': 'package android.os; public class Build { public static String[] SUPPORTED_64_BIT_ABIS={"arm64-v8a"}; public static class VERSION {public static int SDK_INT=24;} }',
  'android/os/Process.java': 'package android.os; public class Process {public static boolean bits=true; public static boolean is64Bit(){return bits;} }',
  [pkg + 'NaturalCaptionTranslator.java']: 'package app.captionstudio.translation; public class NaturalCaptionTranslator { static final String UNSUPPORTED="E_TRANSLATION_UNSUPPORTED", FAILED="failed"; static class TranslationFailure extends Exception {final String code; TranslationFailure(String c,String m){super(m);code=c;} } }',
  [pkg + 'TranslationEnvironment.java']: read('TranslationEnvironment.java'),
  [pkg + 'GeneratedProductContract.java']: read('GeneratedProductContract.java'),
  [pkg + 'AndroidTranslationEnvironment.java']: read('AndroidTranslationEnvironment.java'),
  [pkg + 'CapabilityProbe.java']: [
    'package app.captionstudio.translation;',
    'public class CapabilityProbe { public static void main(String[] args)throws Exception {',
    'AndroidTranslationEnvironment e=new AndroidTranslationEnvironment(new android.content.Context());',
    'for(int sdk:new int[]{24,25,26,35}) { android.os.Build.VERSION.SDK_INT=sdk;',
    'boolean admitted=e.supportsLocalTranslation();String code="allowed";try{e.verifyDeviceCapacity(null);}catch(NaturalCaptionTranslator.TranslationFailure f){code=f.code;}',
    'System.out.println(sdk+":"+admitted+":"+code); }',
    'android.os.Build.VERSION.SDK_INT=26; android.os.Process.bits=false;System.out.println("32bit:"+e.supportsLocalTranslation());',
    'android.os.Process.bits=true;android.app.ActivityManager.low=true;System.out.println("lowram:"+e.supportsLocalTranslation());',
    'android.app.ActivityManager.low=false;android.app.ActivityManager.total=4L*1024*1024*1024-1;System.out.println("below4gb:"+e.supportsLocalTranslation());',
    'android.app.ActivityManager.total=4L*1024*1024*1024;System.out.println("4gb:"+e.supportsLocalTranslation());',
    '} }',
  ].join('\n'),
};
test('actual Android environment denies SDK24/25 on capable hardware and preserves SDK26 constraints', () => {
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const dest = path.join(out, name); mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, text);
  }
  execFileSync('javac', ['-J-Xmx64m', '-d', out, ...Object.keys(files).map(p => path.join(out, p))], { stdio: 'pipe' });
  const lines = execFileSync('java', ['-Xmx32m', '-cp', out, 'app.captionstudio.translation.CapabilityProbe'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  console.log('Native behavioral receipt:', lines.join(', '));
  assert.deepEqual(lines, ['24:false:E_TRANSLATION_UNSUPPORTED','25:false:E_TRANSLATION_UNSUPPORTED',
    '26:true:allowed','35:true:allowed','32bit:false','lowram:false','below4gb:false','4gb:true']);
});
