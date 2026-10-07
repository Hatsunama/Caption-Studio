"""Cloud-only, pinned-release defensive backport construction and evidence."""
import base64,difflib,hashlib,io,json,os,pathlib,subprocess,sys,tarfile,urllib.request
ROOT=pathlib.Path.cwd()
OUT=ROOT/"reviewed-backport-evidence"
OUT.mkdir(exist_ok=True)
BRANCH="codex/dependency-reviewed-backports"
BASE="66705acce04ac0f4f8760847ffe1d8188772a078"
SPECS={
 "braces":{"release":"3.0.3","repo":"micromatch/braces","base":"e53730e6f935498326c72d768889ac194eedc0e0","headrepo":"FSDevelop/braces","head":"28d440b5dd449dbf1fe6f3506cf94ecca4d02660","pr":72,"files":["lib/constants.js","lib/parse.js","lib/compile.js","lib/expand.js","lib/stringify.js"],"tests":["test/compile.js","test/expand.js","test/parse.js","test/stringify.js"],"advisory":"GHSA-vfj7-8cjw-p6xm","identity":"@caption-studio/braces-backport"},
 "node-forge":{"release":"1.4.0","repo":"digitalbazaar/forge","base":"7a43db987bd0ecdc5b41f6d73f58ba6ca5bf9ae1","headrepo":"Krysthyan/forge","head":"ceba34402e329f0365134f23fe19898756527d65","pr":1152,"files":["lib/rsa.js"],"tests":["tests/unit/rsa.js"],"advisory":"GHSA-86w9-cpqp-85rv","identity":"@caption-studio/node-forge-backport"}
}
reports={}
def fetch(url,token=None):
 headers={"User-Agent":"Caption-Studio-reviewed-backports"}
 if token: headers["Authorization"]="Bearer "+token
 req=urllib.request.Request(url,headers=headers)
 with urllib.request.urlopen(req,timeout=60) as r:return r.read()
def api(path,data=None):
 req=urllib.request.Request("https://api.github.com/repos/Hatsunama/Caption-Studio/"+path,
  data=None if data is None else json.dumps(data).encode(),
  headers={"User-Agent":"Caption-Studio-reviewed-backports","Authorization":"Bearer "+os.environ["GH_TOKEN"],"Content-Type":"application/json"})
 with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
def sha(data):return hashlib.sha256(data).hexdigest()
def save(name,obj):(OUT/(name+".json")).write_text(json.dumps(obj,indent=2)+"\n")
def run(name,args,cwd=ROOT,timeout=300,envextra=None):
 env=dict(os.environ)
 env.pop("GH_TOKEN",None);env.pop("GITHUB_TOKEN",None)
 if envextra:env.update(envextra)
 try:
  p=subprocess.run(args,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
  result={"exit_code":p.returncode,"output":p.stdout,"command":args}
 except subprocess.TimeoutExpired as e:
  result={"exit_code":124,"output":str(e.output),"command":args,"timeout":timeout}
 reports[name]=result;save(name,result)
 print(name+" EXIT="+str(result["exit_code"])+"\n"+result["output"][-2000:],flush=True)
 return result["exit_code"]
def require_ok(name,args,**kw):
 if run(name,args,**kw):raise RuntimeError(name+" failed")
def untar(raw,dest,prefix=None):
 with tarfile.open(fileobj=io.BytesIO(raw),mode="r:gz") as tf:
  members=tf.getmembers()
  top=prefix or members[0].name.split("/")[0]
  for m in members:
   if not m.isfile():continue
   rel=pathlib.PurePosixPath(m.name).relative_to(top)
   if ".." in rel.parts or rel.is_absolute():raise RuntimeError("Unsafe archive path")
   target=dest/pathlib.Path(*rel.parts);target.parent.mkdir(parents=True,exist_ok=True)
   target.write_bytes(tf.extractfile(m).read())
def patch_between(name,path,old,new,dest):
 if old==new:return None
 patch="".join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile="a/"+path,tofile="b/"+path))
 patchpath=OUT/(name+"-"+path.replace("/","_")+".patch");patchpath.write_text(patch)
 require_ok("patch_"+name+"_"+path.replace("/","_"),["patch","--batch","--fuzz=0","-p1","-i",str(patchpath)],cwd=dest,timeout=30)
 return {"path":path,"patch_sha256":sha(patch.encode()),"before_sha256":sha(old.encode()),"after_sha256":sha((dest/path).read_bytes())}
def rawfile(repo,ref,path):
 return fetch("https://raw.githubusercontent.com/"+repo+"/"+ref+"/"+path).decode()
def source_tests(name,spec,release_meta,dest):
 archive=fetch("https://codeload.github.com/"+spec["repo"]+"/tar.gz/"+release_meta["gitHead"])
 upstream=OUT/(name+"-release-source");upstream.mkdir()
 untar(archive,upstream)
 # Release-source tests must exercise the exact npm library, not a later head.
 for path in spec["files"]:
  if (upstream/path).read_bytes()!=(dest/path).read_bytes():
   raise RuntimeError("npm/source release mismatch: "+name+"/"+path)
 import shutil
 folder="test" if name=="braces" else "tests"
 shutil.copytree(upstream/folder,dest/folder)
 changes=[]
 # Obtain changed test paths from the exact proposal base/head Git trees.
 headarchive=fetch("https://codeload.github.com/"+spec["headrepo"]+"/tar.gz/"+spec["head"])
 headsrc=OUT/(name+"-proposal");headsrc.mkdir();untar(headarchive,headsrc)
 baseraw=fetch("https://codeload.github.com/"+spec["repo"]+"/tar.gz/"+spec["base"])
 basesrc=OUT/(name+"-proposal-base");basesrc.mkdir();untar(baseraw,basesrc)
 for p in sorted((headsrc/folder).rglob("*.js")):
  rel=p.relative_to(headsrc).as_posix()
  old=(basesrc/rel).read_text() if (basesrc/rel).exists() else ""
  new=p.read_text()
  if old==new:continue
  if rel=="test/mocha-initialization.js":continue  # Node 22 already provides assert.doesNotThrow; omit legacy shim.
  # Only security regression files changed in the reviewed proposal are admitted.
  allowed=({"test/braces.compile.js","test/braces.expand.js","test/braces.parse.js","test/braces.stringify.js","test/mocha-initialization.js"} if name=="braces" else {"tests/unit/rsa.js"})
  if rel not in allowed:raise RuntimeError("Unreviewed test delta: "+rel)
  if not (dest/rel).exists():(dest/rel).parent.mkdir(parents=True,exist_ok=True);(dest/rel).write_text("")
  changes.append(patch_between(name+"-tests",rel,old,new,dest))
 return basesrc,headsrc,changes,sha(archive)
def audit(name,extra=[]):
 rc=run(name,["npm","audit",*extra,"--audit-level=high","--json"],timeout=120)
 obj=json.loads(reports[name]["output"]);save(name+"-parsed",obj)
 print(name+" COUNTS="+json.dumps(obj.get("metadata",{}).get("vulnerabilities",{})),flush=True)
 return rc,obj
def main():
 if os.environ.get("GITHUB_REF")!="refs/heads/"+BRANCH:raise RuntimeError("Isolated branch required")
 require_ok("install_baseline",["npm","ci","--no-fund"],timeout=360)
 audit("red_production_audit",["--omit=dev"])
 require_ok("normal_baseline",["node","tests/dependency-api-compatibility.cjs"],timeout=180)
 harness=OUT/"harness";harness.mkdir()
 (harness/"package.json").write_text(json.dumps({"private":True,"dependencies":{"mocha":"11.7.5","bash-path":"2.0.1","ansi-colors":"3.2.4","webpack":"5.102.1","webpack-cli":"6.0.1"}}))
 require_ok("test_tool_install",["npm","install","--ignore-scripts","--no-audit","--no-fund"],cwd=harness,timeout=240)
 env={"NODE_PATH":str(harness/"node_modules")+os.pathsep+str(ROOT/"node_modules"),"NODE_ENV":"test"}
 mocha=str(harness/"node_modules/mocha/bin/mocha.js")
 vendor=ROOT/"vendor"/"reviewed-backports";vendor.mkdir(parents=True,exist_ok=True)
 provenance={}
 for name,s in SPECS.items():
  meta=json.loads(fetch("https://registry.npmjs.org/"+name+"/"+s["release"]))
  if meta["name"]!=name or meta["version"]!=s["release"] or not meta.get("gitHead"):raise RuntimeError("Bad release metadata")
  tar=fetch(meta["dist"]["tarball"])
  algo,digest=meta["dist"]["integrity"].split("-",1)
  if base64.b64encode(hashlib.new(algo,tar).digest()).decode()!=digest:raise RuntimeError("Release integrity failed")
  dest=vendor/name;dest.mkdir();untar(tar,dest,"package")
  originals={p.relative_to(dest).as_posix():sha(p.read_bytes()) for p in dest.rglob("*") if p.is_file()}
  basesrc,headsrc,testchanges,sourcehash=source_tests(name,s,meta,dest)
  # Exact published baseline normal suite runs before defensive patch.
  if name=="node-forge":
   # The published source accidentally focuses one suite; remove only the focus modifier.
   jsbn_test=dest/"tests/unit/jsbn.js"
   jsbn_text=jsbn_test.read_text()
   if jsbn_text.count("describe.only(")!=1:raise RuntimeError("Unexpected upstream focused suite")
   jsbn_test.write_text(jsbn_text.replace("describe.only(","describe(",1))
  if name=="braces":
   normal=[ "node",mocha,"test/*.js","--grep","reject deeply|self-referencing|cycle involving|nesting exceeds|lower maximum|fractional maximum","--invert"]
   red=["node",mocha,"test/*.js","--grep","reject deeply|self-referencing|cycle involving|nesting exceeds|lower maximum|fractional maximum","--timeout","1000"]
   green=["node",mocha,"test/*.js","--timeout","30000"]
  else:
   normal=["node",mocha,"-t","30000","tests/unit/index.js","--grep","nested DigestAlgorithm element count","--invert"]
   red=["node",mocha,"-t","30000","tests/unit/rsa.js","--grep","nested DigestAlgorithm element count"]
   green=["node",mocha,"-t","30000","tests/unit/index.js"]
  require_ok(name+"_normal_red",normal,cwd=dest,timeout=240,envextra=env)
  rc=run(name+"_defensive_RED",red,cwd=dest,timeout=90,envextra=env)
  if rc in (0,124):raise RuntimeError("Missing bounded assertion RED: "+name)
  if "failing" not in reports[name+"_defensive_RED"]["output"]:raise RuntimeError("RED was infrastructure failure")
  changes=[]
  for path in s["files"]:
   changes.append(patch_between(name,path,(basesrc/path).read_text(),(headsrc/path).read_text(),dest))
  require_ok(name+"_full_GREEN",green,cwd=dest,timeout=300,envextra=env)
  if name=="node-forge":
   # Rebuild every shipped browser bundle from patched lib; retain UMD/worker APIs.
   config="""const path=require('path');
const root=process.argv[2];
const webpack=require(process.argv[3]);
const entries=[['forge',['./lib/index.js'],true],['forge.all',['./lib/index.all.js'],true],['prime.worker',['./lib/prime.worker.js','./lib/forge.js'],false]];
const configs=entries.map(([name,entry,umd])=>({mode:'production',context:root,entry,devtool:'source-map',target:'web',resolve:{fallback:{buffer:false,crypto:false,process:false}},node:{global:false,__filename:false,__dirname:false},output:{path:path.join(root,'dist'),filename:name+'.min.js',globalObject:'typeof self !== "undefined" ? self : this',...(umd?{library:{name:'forge',type:'umd'}}:{})}}));
webpack(configs,(err,stats)=>{if(err||stats.hasErrors()){console.error(err||stats.toString());process.exit(1)}console.log(stats.toString({all:false,assets:true,warnings:true}));});
"""
   build=OUT/"rebuild-forge.cjs";build.write_text(config)
   require_ok("forge_browser_rebuild",["node",str(build),str(dest),str(harness/"node_modules/webpack")],timeout=180,envextra=env)
   # Also run reviewed RSA unit suite against both regenerated bundles.
   bundlecheck=OUT/"bundle-rsa.cjs"
   bundlecheck.write_text("""const path=require('path'),fs=require('fs'),vm=require('vm');
const root=process.env.BACKPORT_BUNDLE_ROOT;
require(path.join(root,'lib/index.js'));
const sandbox={module:{exports:{}},console,setTimeout,clearTimeout,setImmediate,clearImmediate,crypto:require('node:crypto').webcrypto};
Object.assign(sandbox,{ArrayBuffer,Uint8Array,DataView});
sandbox.exports=sandbox.module.exports;sandbox.self=sandbox;sandbox.window=sandbox;
vm.runInNewContext(fs.readFileSync(path.join(root,process.env.BACKPORT_BUNDLE_FILE),'utf8'),sandbox,{timeout:5000});
const bundle=sandbox.module.exports;
if(bundle.util.isNodejs)throw Error('Browser bundle used Node runtime');
if(!bundle.util.isArrayBuffer(new ArrayBuffer(8))||bundle.util.createBuffer(new Uint8Array([1,2])).length()!==2)throw Error('WebCrypto and bundle buffer realms differ');
for(const [file,value] of Object.entries({'forge.js':bundle,'jsbn.js':bundle.jsbn,'md.all.js':bundle.md,'mgf.js':bundle.mgf,'pki.js':bundle.pki,'pss.js':bundle.pss,'random.js':bundle.random,'rsa.js':bundle.pki.rsa,'util.js':bundle.util})){
 if(!value)throw Error('Missing browser API '+file);
 require.cache[require.resolve(path.join(root,'lib',file))].exports=value;
}
require(path.join(root,'tests/unit/rsa.js'));
""")
   for bn in ["forge.min.js","forge.all.min.js"]:
    require_ok("bundle_GREEN_"+bn,["node",mocha,"-t","30000",str(bundlecheck)],cwd=dest,timeout=180,envextra={**env,"BACKPORT_BUNDLE_ROOT":str(dest),"BACKPORT_BUNDLE_FILE":"dist/"+bn})
  package=json.loads((dest/"package.json").read_text())
  package["name"]=s["identity"];package["version"]=s["release"]+"-caption-studio.1";package["private"]=True
  package["captionStudioBackport"]={"upstreamName":name,"upstreamVersion":s["release"],"upstreamGitHead":meta["gitHead"],"proposalHead":s["head"],"advisory":s["advisory"],"patches":[x for x in changes if x]}
  package["scripts"]={};package.pop("devDependencies",None)
  (dest/"package.json").write_text(json.dumps(package,indent=2)+"\n")
  p={"release":meta,"release_tar_sha256":sha(tar),"release_source_sha256":sourcehash,"release_files_sha256":originals,"proposal":s,"patches":changes,"regression_patches":testchanges,"private_identity":package["name"],"backport_version":package["version"]}
  p["backport_files_sha256"]={f.relative_to(dest).as_posix():sha(f.read_bytes()) for f in dest.rglob("*") if f.is_file()}
  save(name+"-provenance",p);provenance[name]=p
  (dest/"BACKPORT-PROVENANCE.json").write_text(json.dumps(p,indent=2)+"\n")
  require_ok("pack_"+name,["npm","pack","--ignore-scripts","--json","--pack-destination",str(vendor)],cwd=dest,timeout=60)
  packed=json.loads(reports["pack_"+name]["output"])[0]
  p["packed"]=packed
  save(name+"-provenance",p)
 pkg=json.loads((ROOT/"package.json").read_text())
 for name,p in provenance.items():pkg["overrides"][name]="file:vendor/reviewed-backports/"+p["packed"]["filename"]
 (ROOT/"package.json").write_text(json.dumps(pkg,indent=2)+"\n")
 require_ok("resolve_backport_lock",["npm","install","--package-lock-only","--ignore-scripts","--no-fund"],timeout=360)
 require_ok("install_backport_lock",["npm","ci","--no-fund"],timeout=360)
 lock=json.loads((ROOT/"package-lock.json").read_text())
 for name,p in provenance.items():
  matches=[(k,v) for k,v in lock["packages"].items() if k.endswith("/"+name)]
  if not matches:raise RuntimeError("Backport not installed: "+name)
  for k,v in matches:
   if v.get("name")!=p["private_identity"] or v["version"]!=p["backport_version"]:raise RuntimeError("Unpatched nested instance: "+k)
   if v.get("integrity")!=p["packed"]["integrity"]:raise RuntimeError("Lock integrity mismatch: "+k)
 require_ok("consumer_GREEN",["node","tests/dependency-api-compatibility.cjs"],timeout=180)
 require_ok("published_GREEN",["node","--test","tests/published-dependency-regressions.cjs"],timeout=60)
 run("full_repository",["python3","tests/translation-preservation-cloud.py"],timeout=1200)
 full=json.loads((ROOT/"preservation-repair-results.json").read_text());save("full_repository_reports",full)
 production_rc,production=audit("green_production_audit",["--omit=dev"])
 all_rc,all_audit=audit("green_all_audit")
 blocked={k:v for k,v in full["reports"].items() if "exit_code" not in v or v["exit_code"]!=0}
 save("provenance",provenance)
 summary={"base":BASE,"tested_head":os.environ["GITHUB_SHA"],"production_audit_exit":production_rc,"all_audit_exit":all_rc,"full_repository_blockers":list(blocked),"identities":{k:{"name":p["private_identity"],"version":p["backport_version"],"integrity":p["packed"]["integrity"]} for k,p in provenance.items()},"audit_interpretation":"npm advisory coverage does not validate private forks. Exact-release integrity, reviewed minimal patches, RED/GREEN upstream tests, consumer tests and source hashes are the independent evidence. No advisory exclusion or gate waiver."}
 save("summary",summary)
 # Publish cloud-produced candidate and reports as immutable objects; connector applies ref after review.
 paths=["package.json","package-lock.json"]
 paths += [p.relative_to(ROOT).as_posix() for p in vendor.rglob("*") if p.is_file()]
 reportpath="docs/dependency-reviewed-backports"
 reportdir=ROOT/reportpath;reportdir.mkdir(parents=True,exist_ok=True)
 (reportdir/"REPORT.json").write_text(json.dumps(summary,indent=2)+"\n")
 (reportdir/"README.md").write_text("""# Maintained private dependency backports
These packages derive from exact integrity-verified npm releases. Only defensive proposal deltas are applied, with zero patch fuzz; unrelated upstream parser changes are excluded. Original licenses and authorship are retained. Private names and prerelease versions identify actual patched copies, not published upstream fixes. Nothing is published to npm.
Caption Studio maintainers own these forks, must monitor both upstream advisories and proposal revisions, rerun this cloud workflow on updates, and replace the forks with published maintained fixes when available. npm audit has no independent knowledge of private fork vulnerabilities. Production and all-dependency audits are recorded unmodified; security regressions and compatibility suites are mandatory additional evidence.
The node-forge distribution bundles are regenerated from patched sources with pinned webpack tooling. Package tarballs have lockfile integrity and committed source hashes. Build/test tool lock is retained in evidence. RED tests are exact upstream proposal unit regressions; no custom exploit probe is added.
Full repository evidence includes JS logic, product contracts, TypeScript, lint, Expo compatibility/doctor, and real SDK native unit compilation/tests. Android release builds/signing/device validation are outside this isolated task.
""")
 paths += [p.relative_to(ROOT).as_posix() for p in reportdir.rglob("*") if p.is_file()]
 # Retain full transcripts (not just summary) as committed evidence.
 for name,result in reports.items():
  (reportdir/(name+".json")).write_text(json.dumps(result,indent=2)+"\n")
  paths.append((reportdir/(name+".json")).relative_to(ROOT).as_posix())
 for filename in ["full_repository_reports.json","provenance.json"]:
  (reportdir/filename).write_bytes((OUT/filename).read_bytes());paths.append(reportpath+"/"+filename)
 head=api("git/ref/heads/"+BRANCH)["object"]["sha"]
 if head!=os.environ["GITHUB_SHA"]:raise RuntimeError("Branch moved")
 tree=api("git/commits/"+head)["tree"]["sha"];entries=[]
 for path in paths:
  data=(ROOT/path).read_bytes()
  blob=api("git/blobs",{"content":base64.b64encode(data).decode(),"encoding":"base64"})
  entries.append({"path":path,"mode":"100644","type":"blob","sha":blob["sha"]})
 newtree=api("git/trees",{"base_tree":tree,"tree":entries})["sha"]
 commit=api("git/commits",{"message":"fix(deps): vendor reviewed defensive backports with RED GREEN evidence","tree":newtree,"parents":[head]})["sha"]
 summary["candidate_commit"]=commit;save("summary",summary)
 print("IMMUTABLE_CANDIDATE_COMMIT="+commit,flush=True)
 if production_rc or all_rc or blocked:raise RuntimeError("Validation/audit blocked; candidate is evidence only, do not adopt")
 print("VALIDATED_CANDIDATE_COMMIT="+commit,flush=True)
try:
 main()
except Exception as e:
 save("blocker",{"type":type(e).__name__,"message":str(e),"head":os.environ.get("GITHUB_SHA")})
 print("BLOCKER="+repr(e),flush=True)
 sys.exit(1)
