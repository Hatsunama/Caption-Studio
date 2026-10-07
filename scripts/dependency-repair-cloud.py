import os,json,pathlib,subprocess,urllib.request,urllib.parse,io,zipfile,hashlib,tarfile,sys,shutil
ROOT=pathlib.Path.cwd()
OUT=ROOT/"dependency-repair-evidence"
OUT.mkdir(exist_ok=True)
BRANCH="codex/dependency-repair-expo57-20261007"
PINS={"expo":"57.0.27","expo-asset":"57.0.19","expo-constants":"57.0.21","expo-linking":"57.0.12","expo-router":"57.0.25","expo-sqlite":"57.0.4"}
TRANSITIVE={"shell-quote":"1.11.0","source-map-js":"1.2.2"}
def run(name,args,timeout=600):
    env=dict(os.environ);env.pop("GH_TOKEN",None);env.pop("GITHUB_TOKEN",None)
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout,env=env)
    (OUT/(name+".log")).write_text(p.stdout)
    (OUT/(name+".json")).write_text(json.dumps({"command":args,"exit_code":p.returncode,"output":p.stdout},indent=2))
    print(name+" EXIT="+str(p.returncode)+"\n"+p.stdout[-6000:],flush=True)
    return p.returncode
def get(url,token=None):
    headers={"User-Agent":"Caption-Studio-dependency-repair"}
    if token:headers["Authorization"]="Bearer "+token
    class SafeRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,hdrs,newurl):
            redirected=super().redirect_request(req,fp,code,msg,hdrs,newurl)
            if urllib.parse.urlparse(req.full_url).netloc!=urllib.parse.urlparse(newurl).netloc:
                redirected.remove_header("Authorization")
            return redirected
    opener=urllib.request.build_opener(SafeRedirect())
    with opener.open(urllib.request.Request(url,headers=headers),timeout=120) as r:return r.read()
def api(path,data=None,method=None):
    headers={"User-Agent":"Caption-Studio-dependency-repair","Authorization":"Bearer "+os.environ["GH_TOKEN"],"Accept":"application/vnd.github+json"}
    raw=None if data is None else json.dumps(data).encode()
    if raw is not None:headers["Content-Type"]="application/json"
    req=urllib.request.Request("https://api.github.com/repos/Hatsunama/Caption-Studio/"+path,data=raw,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=120) as r:return json.load(r)
def roots(a):
    return [{"package":k,"severity":v["severity"],"url":x["url"],"range":x["range"]} for k,v in a.get("vulnerabilities",{}).items() for x in v.get("via",[]) if isinstance(x,dict)]
def audit(name):
    rc=run(name,["npm","audit","--omit=dev","--audit-level=high","--json"],180)
    a=json.loads(json.loads((OUT/(name+".json")).read_text())["output"])
    print(name+"_ROOTS="+json.dumps(roots(a)),flush=True)
    print(name+"_COUNTS="+json.dumps(a.get("metadata",{}).get("vulnerabilities",{})),flush=True)
    return rc,a
phase=sys.argv[1]
if os.environ.get("GITHUB_REF")!="refs/heads/"+BRANCH:raise RuntimeError("Only the isolated dependency branch is allowed")
if phase=="artifact":
    data=get("https://api.github.com/repos/Hatsunama/Caption-Studio/actions/artifacts/11452058865/zip",os.environ["GH_TOKEN"])
    actual=hashlib.sha256(data).hexdigest()
    if actual!="a2ea7947c772fcd935d5f360ca004f6aa6b04c59b2adeddc80258f00b0029f69":raise RuntimeError("Artifact digest mismatch")
    obj=json.loads(zipfile.ZipFile(io.BytesIO(data)).read("preservation-repair-results.json"))
    if obj["head"]!="4c421437a13c394910647c5d7b57fe8e86a32245":raise RuntimeError("Artifact head mismatch")
    (OUT/"actual-preservation-artifact.json").write_text(json.dumps(obj,indent=2))
    a=json.loads(obj["reports"]["production_audit"]["output"])
    print("VERIFIED_ACTUAL_ARTIFACT_SHA256="+actual)
    print("ACTUAL_BASELINE_ROOTS="+json.dumps(roots(a)))
    print("ACTUAL_BASELINE_COUNTS="+json.dumps(a["metadata"]["vulnerabilities"]))
elif phase=="repair":
    baseline=json.loads((OUT/"actual-preservation-artifact.json").read_text())
    expected_green=["green_js","full_logic","product_contract","typescript","lint","compile_real_sdk_adapter","compile_native_tests","full_native","green_native"]
    if any(baseline["reports"][name]["exit_code"]!=0 for name in expected_green):raise RuntimeError("Verified original behavioral baseline is not green")
    (OUT/"before_full_reports.json").write_text(json.dumps(baseline,indent=2))
    print("REUSED_DIGEST_VERIFIED_ORIGINAL_FULL_BASELINE="+baseline["head"],flush=True)
    rc,a=audit("before_audit")
    if rc!=1:raise RuntimeError("Expected failing current audit baseline")
    regression_before=run("before_published_regressions",["node","--test","tests/published-dependency-regressions.cjs"],60)
    if regression_before!=1:raise RuntimeError("Expected failing safe defensive regression baseline")
    normal_before=run("before_dependency_api",["node","tests/dependency-api-compatibility.cjs"],180)
    if normal_before:raise RuntimeError("Normal API baseline failed; refusing dependency mutations")
    metadata={}
    for name,version in {**PINS,**TRANSITIVE}.items():
        meta=json.loads(get("https://registry.npmjs.org/"+urllib.parse.quote(name,safe="")+"/"+version))
        if meta["name"]!=name or meta["version"]!=version or not meta["dist"].get("integrity"):raise RuntimeError("Registry pin not verified")
        metadata[name]=meta
    (OUT/"published-pin-metadata.json").write_text(json.dumps(metadata,indent=2))
    latest={}
    for name in ["braces","node-forge"]:
        latest[name]=json.loads(get("https://registry.npmjs.org/"+name+"/latest"))
    (OUT/"blocked-root-current-registry.json").write_text(json.dumps(latest,indent=2))
    print("BLOCKED_ROOT_LATEST="+json.dumps({k:v["version"] for k,v in latest.items()}),flush=True)
    # Read the official SDK package's compatibility table without extracting code.
    expo_tar=get(metadata["expo"]["dist"]["tarball"])
    with tarfile.open(fileobj=io.BytesIO(expo_tar),mode="r:gz") as tf:
        bundled=json.load(tf.extractfile("package/bundledNativeModules.json"))
    (OUT/"expo57-bundledNativeModules.json").write_text(json.dumps(bundled,indent=2))
    pkg=json.loads((ROOT/"package.json").read_text())
    pkg["dependencies"].update(PINS)
    pkg["overrides"].update(TRANSITIVE)
    (ROOT/"package.json").write_text(json.dumps(pkg,indent=2)+"\n")
    if run("resolve_pinned_lock",["npm","install","--package-lock-only","--ignore-scripts","--no-fund"],360):raise RuntimeError("Lock resolution failed")
    if run("install_pinned_lock",["npm","ci","--no-fund"],360):raise RuntimeError("Locked install failed")
    actual=json.loads((ROOT/"package-lock.json").read_text())
    for name,version in {**PINS,**TRANSITIVE}.items():
        if actual["packages"]["node_modules/"+name]["version"]!=version:raise RuntimeError("Lock pin mismatch "+name)
    for key,value in actual["packages"].items():
        if key.endswith("/shell-quote") and value["version"]!="1.11.0":raise RuntimeError("Unfixed nested shell-quote")
        if key.endswith("/source-map-js") and value["version"]!="1.2.2":raise RuntimeError("Unfixed nested source-map-js")
    regression_after=run("after_published_regressions",["node","--test","tests/published-dependency-regressions.cjs"],60)
    if regression_after:raise RuntimeError("Published defensive regressions failed")
    compat=run("after_dependency_api",["node","tests/dependency-api-compatibility.cjs"],180)
    for generated in ["test-jars","test-classes"]:
        target=(ROOT/generated).resolve()
        if target.parent!=ROOT.resolve():raise RuntimeError("Unexpected generated directory")
        if target.exists():shutil.rmtree(target)
    after=run("after_full",["python3","tests/translation-preservation-cloud.py"],1200)
    report=json.loads((ROOT/"preservation-repair-results.json").read_text())
    (OUT/"after_full_reports.json").write_text(json.dumps(report,indent=2))
    auditrc,afteraudit=audit("after_audit")
    blocked=[k for k,v in report["reports"].items() if v.get("exit_code")!=0 and k!="production_audit"]
    if compat or blocked:raise RuntimeError("Compatibility failure: "+repr(blocked))
    if any(x["package"] in TRANSITIVE for x in roots(afteraudit)):raise RuntimeError("Published security fix still flagged")
    state={"head":os.environ["GITHUB_SHA"],"pins":PINS,"overrides":TRANSITIVE,"audit_exit":auditrc,"audit_counts":afteraudit.get("metadata",{}).get("vulnerabilities"),"roots":roots(afteraudit),"compatibility_passed":True,"after_full_exit":after}
    (OUT/"result.json").write_text(json.dumps(state,indent=2))
    print("REPAIR_VALIDATED="+json.dumps(state),flush=True)
elif phase=="publish":
    state=json.loads((OUT/"result.json").read_text())
    if not state["compatibility_passed"]:raise RuntimeError("No verified compatibility result")
    head=api("git/ref/heads/"+BRANCH)["object"]["sha"]
    if head!=os.environ["GITHUB_SHA"]:raise RuntimeError("Branch moved; refusing publication")
    tree=api("git/commits/"+head)["tree"]["sha"]
    entries=[]
    for path in ["package.json","package-lock.json"]:
        content=(ROOT/path).read_text()
        entries.append({"path":path,"mode":"100644","type":"blob","content":content})
        state[path+"_sha256"]=hashlib.sha256(content.encode()).hexdigest()
    newtree=api("git/trees",{"base_tree":tree,"tree":entries})["sha"]
    commit=api("git/commits",{"message":"fix(deps): pin published security fixes and align Expo 57 patches","tree":newtree,"parents":[head]})["sha"]
    if api("git/ref/heads/"+BRANCH)["object"]["sha"]!=head:raise RuntimeError("Branch moved before update")
    api("git/refs/heads/"+BRANCH,{"sha":commit,"force":False},method="PATCH")
    state["dependency_commit"]=commit
    (OUT/"result.json").write_text(json.dumps(state,indent=2))
    print("PUBLISHED_DEPENDENCY_COMMIT="+commit)
elif phase=="gate":
    state=json.loads((OUT/"result.json").read_text())
    print("FINAL_RESULT="+json.dumps(state),flush=True)
    sys.exit(state["audit_exit"])
