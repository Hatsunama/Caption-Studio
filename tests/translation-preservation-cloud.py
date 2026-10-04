import json, os, pathlib, subprocess, sys
root=pathlib.Path.cwd()
reports={}
def run(name,args,cwd=None,timeout=240):
    p=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
    reports[name]={"exit_code":p.returncode,"output":p.stdout,"command":args}
    print(name+": exit="+str(p.returncode),flush=True)
    print(p.stdout if name.startswith("red_") or name.startswith("compile") else p.stdout[-3500:],flush=True)
    return p.returncode
import urllib.request, io, zipfile
def fetch(url):
    with urllib.request.urlopen(url,timeout=120) as r: return r.read()
try:
    baseline=sorted(str(p) for p in (root/"tests").glob("*.test.mjs") if p.name!="translation-preservation-acceptance.test.mjs")
    run("baseline_full_logic",["node","--import","tsx","--test"]+baseline,root,timeout=360)
    run("red_js",["node","--import","tsx","--test","tests/translation-preservation-acceptance.test.mjs"],root)
    run("full_logic_with_red_regressions",["npm","run","test:logic"],root,timeout=360)
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
    android=maven("org.robolectric","android-all","15-robolectric-12650502")
    stdlib=maven("org.jetbrains.kotlin","kotlin-stdlib","2.3.0")
    annotations=maven("org.jetbrains","annotations","26.0.2")
    compiler=":".join([
        maven("org.jetbrains.kotlin","kotlin-compiler-embeddable","2.3.0"),stdlib,
        maven("org.jetbrains.kotlin","kotlin-script-runtime","2.3.0"),
        maven("org.jetbrains.kotlin","kotlin-reflect","2.3.0"),
        maven("org.jetbrains.kotlin","kotlin-daemon-embeddable","2.3.0"),
        maven("org.jetbrains.kotlinx","kotlinx-coroutines-core-jvm","1.10.2"),
        annotations])
    aar=zipfile.ZipFile(io.BytesIO(fetch("https://dl.google.com/dl/android/maven2/com/google/ai/edge/litertlm/litertlm-android/0.16.1/litertlm-android-0.16.1.aar")))
    litert=jars/"litertlm-0.16.1.jar"
    litert.write_bytes(aar.read("classes.jar"))
    classes=root/"test-classes"
    classes.mkdir()
    cp=":".join(map(str,[classes,android,gson,junit,hamcrest,stdlib,annotations,litert]))
    main=root/"modules/caption-translation/android/src/main/java/app/captionstudio/translation"
    tests=root/"modules/caption-translation/android/src/test/java/app/captionstudio/translation"
    java=list(map(str,main.glob("*.java")))
    kotlin=run("compile_real_sdk_adapter",["java","-cp",compiler,"org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
        "-no-stdlib","-no-reflect","-jvm-target","17","-classpath",cp,"-d",str(classes),
        str(main/"LiteRtLmTranslationRuntime.kt")]+java,timeout=180)
    javac=run("compile_native_tests",["javac","-encoding","UTF-8","-cp",cp,"-d",str(classes)]+java+list(map(str,tests.glob("*.java"))),timeout=180)
    if kotlin==0 and javac==0:
        baseline=["app.captionstudio.translation."+p.stem for p in tests.glob("*Test.java") if p.stem!="TranslationPreservationAcceptanceTest"]
        run("baseline_full_native",["java","-cp",cp,"org.junit.runner.JUnitCore"]+baseline,timeout=240)
        run("red_native",["java","-cp",cp,"org.junit.runner.JUnitCore","app.captionstudio.translation.TranslationPreservationAcceptanceTest"],timeout=120)
except Exception as e:
    reports["infrastructure_error"]={"type":type(e).__name__,"message":str(e)}
    print("INFRASTRUCTURE_ERROR="+repr(e),flush=True)
finally:
    (root/"preservation-red-results.json").write_text(json.dumps({"base":"cbb60fb58ed448f2146145ae2d2ccca2ec75dde1","production_edited":False,"stage":"RED_ONLY_SCOPE_STOP","reports":reports},indent=2))
    print("RESULTS="+json.dumps({k:v.get("exit_code",v.get("type")) for k,v in reports.items()}),flush=True)
