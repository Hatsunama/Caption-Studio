import json, os, pathlib, subprocess, sys
root=pathlib.Path.cwd()
reports={}
def run(name,args,cwd=None,timeout=240):
    p=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
    reports[name]={"exit_code":p.returncode,"output":p.stdout,"command":args}
    print(name+": exit="+str(p.returncode),flush=True)
    print(p.stdout if name.startswith("green_") or name.startswith("compile") else p.stdout[-3500:],flush=True)
    return p.returncode
import urllib.request, io, zipfile, hashlib
def fetch(url):
    with urllib.request.urlopen(url,timeout=120) as r: return r.read()
try:
    run("green_js",["node","--import","tsx","--test","tests/translation-preservation-acceptance.test.mjs","tests/translation-preservation-contract.test.mjs"],root)
    run("full_logic",["npm","run","test:logic"],root,timeout=360)
    run("product_contract",["npm","run","verify:product-contract"],root)
    run("typescript",["node","node_modules/typescript/bin/tsc","--noEmit"],root,timeout=240)
    run("lint",["npm","run","lint"],root,timeout=300)
    run("production_audit",["npm","audit","--omit=dev","--audit-level=high","--json"],root,timeout=120)
    run("expo_compatibility",["node","node_modules/expo/bin/cli","install","--check"],root,timeout=240)
    run("expo_doctor",["npx","--yes","expo-doctor@1.20.4"],root,timeout=240)
    jars=root/"test-jars"
    jars.mkdir()
    def maven(group,artifact,version):
        filename=artifact+"-"+version+".jar"
        dest=jars/filename
        dest.write_bytes(fetch("https://repo.maven.apache.org/maven2/"+group.replace(".","/")+"/"+artifact+"/"+version+"/"+filename))
        return str(dest)
    gson=maven("com.google.code.gson","gson","2.13.2")
    junit=maven("junit","junit","4.13.2")
    hamcrest=maven("org.hamcrest","hamcrest-core","1.3")
    mockito=maven("org.mockito","mockito-core","5.14.2")
    bytebuddy=maven("net.bytebuddy","byte-buddy","1.15.4")
    bytebuddy_agent=maven("net.bytebuddy","byte-buddy-agent","1.15.4")
    objenesis=maven("org.objenesis","objenesis","3.3")
    android=str(pathlib.Path(os.environ["ANDROID_HOME"])/"platforms/android-36/android.jar")
    if not pathlib.Path(android).is_file(): raise RuntimeError("Runner Android 36 platform jar unavailable")
    stdlib=maven("org.jetbrains.kotlin","kotlin-stdlib","2.3.0")
    annotations=maven("org.jetbrains","annotations","26.0.2")
    compiler=":".join([
        maven("org.jetbrains.kotlin","kotlin-compiler-embeddable","2.3.0"),stdlib,
        maven("org.jetbrains.kotlin","kotlin-script-runtime","2.3.0"),
        maven("org.jetbrains.kotlin","kotlin-reflect","2.3.0"),
        maven("org.jetbrains.kotlin","kotlin-daemon-embeddable","2.3.0"),
        maven("org.jetbrains.kotlinx","kotlinx-coroutines-core-jvm","1.10.2"),
        annotations])
    aar_bytes=fetch("https://dl.google.com/dl/android/maven2/com/google/ai/edge/litertlm/litertlm-android/0.16.1/litertlm-android-0.16.1.aar")
    if hashlib.sha256(aar_bytes).hexdigest() != "e407719c1a29f2685fcb6aa3feea0b9f7155fe316c66dae053c1b5b2f54cda73":
        raise RuntimeError("Pinned LiteRT-LM AAR SHA-256 mismatch")
    aar=zipfile.ZipFile(io.BytesIO(aar_bytes))
    litert=jars/"litertlm-0.16.1.jar"
    litert.write_bytes(aar.read("classes.jar"))
    classes=root/"test-classes"
    classes.mkdir()
    resources=root/"modules/caption-translation/android/src/test/resources"
    coroutines=str(jars/"kotlinx-coroutines-core-jvm-1.10.2.jar")
    cp=":".join(map(str,[classes,resources,android,gson,junit,hamcrest,stdlib,annotations,litert,mockito,bytebuddy,bytebuddy_agent,objenesis,coroutines]))
    main=root/"modules/caption-translation/android/src/main/java/app/captionstudio/translation"
    tests=root/"modules/caption-translation/android/src/test/java/app/captionstudio/translation"
    java=list(map(str,main.glob("*.java")))
    kotlin=run("compile_real_sdk_adapter",["java","-cp",compiler,"org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
        "-no-stdlib","-no-reflect","-jvm-target","17","-classpath",cp,"-d",str(classes),
        *list(map(str, (p for p in main.glob("*.kt") if p.name != "CaptionTranslationModule.kt")))]+java,timeout=180)
    javac=run("compile_native_tests",["javac","-encoding","UTF-8","-cp",cp,"-d",str(classes)]+java+list(map(str,tests.glob("*.java"))),timeout=180)
    if kotlin==0 and javac==0:
        all_tests=sorted("app.captionstudio.translation."+p.stem for p in tests.glob("*Test.java"))
        run("full_native",["java","-javaagent:"+bytebuddy_agent,"-cp",cp,"org.junit.runner.JUnitCore"]+all_tests,timeout=240)
        run("green_native",["java","-cp",cp,"org.junit.runner.JUnitCore","app.captionstudio.translation.TranslationPreservationAcceptanceTest","app.captionstudio.translation.TranslationPreservationContractTest"],timeout=120)
except Exception as e:
    reports["infrastructure_error"]={"type":type(e).__name__,"message":str(e)}
    print("INFRASTRUCTURE_ERROR="+repr(e),flush=True)
finally:
    (root/"preservation-repair-results.json").write_text(json.dumps({"base":"95cdecc54fa6efaa0f52e7cab19f61d8de4873a1","stage":"SDK_TYPED_CANCEL_ADAPTER","head":os.environ.get("GITHUB_SHA"),"reports":reports},indent=2))
    print("RESULTS="+json.dumps({k:v.get("exit_code",v.get("type")) for k,v in reports.items()}),flush=True)
sys.exit(1 if any("exit_code" not in value or value["exit_code"] != 0 for value in reports.values()) else 0)
