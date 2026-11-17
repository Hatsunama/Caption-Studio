"""Verification-only derivation of the immutable final Play AAB. Python stdlib only."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import urllib.request
import zipfile

REPO = 'Hatsunama/Caption-Studio'
OWNER = 'Hatsunama'
SOURCE = '55e3fa0fbb62f41d23f954cb60e3dda6edbb3e4d'
TREE = '0502b4f55c1362d8a4f95d3a84976e48bc7203ca'
BRANCH = 'refs/heads/qa/derive-play145-20261117'
SHA = '7c84f4f37b9bde6feaa7de8f939f891b2ecb79948fd9546c546977bb9ad2104b'
SIZE = 141264708
TOOL_SHA = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29'
TOOL_URL = 'https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar'
PACKAGE = 'com.xmilo_at_your_side.caption_studio'
FLOOR = 1024 * 1024 * 1024
PREFIX = 'qa/play145/'
ROLES = {'samsung': 37, 'seeker': 36}
BASE_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
FLAGS = ['-Xmx256m', '-XX:ActiveProcessorCount=1', '-XX:+UseSerialGC']


def need(ok, message):
    if not ok:
        raise ValueError(message)


def closed(obj, keys):
    need(type(obj) is dict and set(obj) == set(keys.split()), 'Closed schema mismatch')


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def load(path):
    need(path.stat().st_size <= 65536, 'JSON too large')
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def verify(path, sha, size=None):
    need(path.is_file() and not path.is_symlink(), 'Invalid input file')
    need(size is None or path.stat().st_size == size, 'Input size mismatch')
    need(digest(path) == sha, 'Input SHA256 mismatch')


def config(path):
    c = load(path)
    closed(c, 'repository source sourceTree aab devices')
    need((c['repository'], c['source'], c['sourceTree']) == (REPO, SOURCE, TREE), 'Source pin mismatch')
    a = c['aab']
    closed(a, 'sha256 size assetId releaseId')
    need(a['sha256'] == SHA and type(a['size']) is int and a['size'] == SIZE, 'AAB pin mismatch')
    for name in ('assetId', 'releaseId'):
        need(type(a[name]) is int and 0 < a[name] < 2**63, 'Actual positive ID required')
    closed(c['devices'], 'samsung seeker')
    for role, d in c['devices'].items():
        closed(d, 'path sha256')
        need(d['path'] == PREFIX + role + '.json', 'Fixed role path required')
        need(type(d['sha256']) is str and re.fullmatch('[0-9a-f]{64}', d['sha256']), 'Actual spec SHA256 required')
    return c


def check_specs(c, qa):
    for role, expected_sdk in ROLES.items():
        d = c['devices'][role]
        p = qa / d['path']
        need(p.resolve().is_relative_to(qa.resolve()), 'Spec path redirected')
        verify(p, d['sha256'])
        spec = load(p)
        need(type(spec) is dict and spec.get('sdkVersion') == expected_sdk
             and type(spec.get('sdkVersion')) is int and spec.get('screenDensity') == 480
             and type(spec.get('screenDensity')) is int, 'Actual device SDK/density mismatch')
        abis = spec.get('supportedAbis')
        locales = spec.get('supportedLocales')
        need(type(abis) is list and 'arm64-v8a' in abis and all(type(x) is str and x for x in abis), 'Actual arm64 ABI list required')
        need(type(locales) is list and locales and all(type(x) is str and x for x in locales), 'Actual locales required')
        need(not any('serial' in k.lower() for k in spec), 'Personal serial must not enter CI')


def run(args, env=None, output=None):
    r = subprocess.run(args, env=BASE_ENV if env is None else env,
                       stdin=subprocess.DEVNULL, stdout=output or subprocess.PIPE,
                       stderr=subprocess.PIPE, timeout=420, check=False, shell=False)
    status = re.search(rb'HTTP ([0-9]{3})', r.stderr or b'')
    detail = (' HTTP ' + status[1].decode()) if status else ''
    need(r.returncode == 0, 'Subprocess failed exit=' + str(r.returncode) + detail)
    return r.stdout if output is None else b''


def git(root, *args):
    return run(['git', '-C', str(root), *args]).decode().strip()


def gates(qa, source, env):
    need(env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_EVENT_NAME') == 'push'
         and env.get('GITHUB_REPOSITORY') == REPO and env.get('GITHUB_ACTOR') == OWNER
         and env.get('GITHUB_TRIGGERING_ACTOR') == OWNER and env.get('GITHUB_REF') == BRANCH,
         'Authorized public-repository QA push only')
    need(env.get('GITHUB_WORKFLOW_REF') == REPO + '/.github/workflows/qa-play145-apks.yml@' + BRANCH, 'Workflow ref mismatch')
    event = load(Path(env['GITHUB_EVENT_PATH']))
    need(event.get('repository', {}).get('private') is False and not event.get('deleted'), 'Public repository live branch required')
    need(git(source, 'rev-parse', 'HEAD') == SOURCE and git(source, 'rev-parse', 'HEAD^{tree}') == TREE, 'Pinned source checkout mismatch')
    head = git(qa, 'rev-parse', 'HEAD')
    need(head == env.get('GITHUB_SHA'), 'QA head mismatch')
    git(qa, 'merge-base', '--is-ancestor', SOURCE, head)
    allowed = {'.github/workflows/qa-play145-apks.yml', 'scripts/qa-play145-apks.py',
               PREFIX + 'config.json', PREFIX + 'samsung.json', PREFIX + 'seeker.json'}
    changed = set(git(qa, 'diff', '--name-only', SOURCE, head).splitlines())
    need(changed and changed <= allowed, 'QA branch changes exceed verification-only paths')
    for checkout in (qa, source):
        need(not git(checkout, 'status', '--porcelain', '--untracked-files=no'), 'Checkout has tracked modifications')
    return head


def memory(text=None):
    text = Path('/proc/meminfo').read_text() if text is None else text
    match = re.search(r'^MemAvailable:\s+(\d+) kB$', text, re.M)
    need(match is not None and int(match[1]) * 1024 >= FLOOR, 'MemAvailable below immutable 1 GiB floor')
    return int(match[1]) * 1024


def java_env(home):
    return dict(BASE_ENV, HOME=str(home), TMPDIR=str(home))


def metadata(m, a):
    need(type(m.get('id')) is int and m['id'] == a['assetId']
         and m.get('size') == SIZE and m.get('digest') == 'sha256:' + SHA
         and m.get('state') == 'uploaded' and m.get('uploader', {}).get('login') == OWNER,
         'Release asset metadata mismatch')


def fetch(c, work, env):
    a = c['aab']
    gh_env = dict(BASE_ENV, GH_TOKEN=env.get('GH_TOKEN', ''), GH_HOST='github.com', GH_CONFIG_DIR=str(work / 'gh-config'))
    need(gh_env['GH_TOKEN'], 'Read-only job token required only in download step')
    def api(endpoint, accept='application/vnd.github+json', output=None):
        return run(['gh', 'api', '--hostname', 'github.com', '--method', 'GET',
                    '-H', 'Accept: ' + accept, '-H', 'X-GitHub-Api-Version: 2022-11-28',
                    'repos/' + REPO + '/' + endpoint], env=gh_env, output=output)
    print('Checking fixed draft release metadata', flush=True)
    release = json.loads(api('releases/' + str(a['releaseId'])), object_pairs_hook=unique)
    need(release.get('id') == a['releaseId'] and release.get('draft') is True, 'Private draft release required')
    need(any(x.get('id') == a['assetId'] for x in release.get('assets', [])), 'Asset not in selected draft')
    endpoint = 'releases/assets/' + str(a['assetId'])
    print('Checking fixed AAB asset metadata', flush=True)
    metadata(json.loads(api(endpoint), object_pairs_hook=unique), a)
    print('Downloading exact signed AAB', flush=True)
    with (work / 'final.aab').open('xb') as f:
        api(endpoint, 'application/octet-stream', f)
    verify(work / 'final.aab', SHA, SIZE)
    metadata(json.loads(api(endpoint), object_pairs_hook=unique), a)
    # This receipt is written only after actual read-only private asset access succeeds.
    write(work / 'download.json', {'assetId': a['assetId'], 'releaseId': a['releaseId'], 'sha256': SHA, 'size': SIZE, 'privateDraftAccess': 'PROVEN_BY_THIS_JOB'})


def write(path, data):
    with path.open('x', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write('\n')


def fields(data):
    """Bounded protobuf wire reader; only fixed bundletool 1.18.3 TOC fields used."""
    pos = 0
    def varint():
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            need(pos < len(data), 'Truncated protobuf')
            b = data[pos]
            pos += 1
            value |= (b & 127) << shift
            if b < 128:
                return value
        raise ValueError('Oversized protobuf varint')
    result = {}
    while pos < len(data):
        tag = varint()
        number, wire = tag >> 3, tag & 7
        need(number > 0, 'Invalid protobuf tag')
        if wire == 0:
            value = varint()
        else:
            need(wire in (1, 2, 5), 'Unsupported protobuf wire type')
            size = varint() if wire == 2 else (8 if wire == 1 else 4)
            need(pos + size <= len(data), 'Truncated protobuf field')
            value = data[pos:pos + size]
            pos += size
        result.setdefault(number, []).append(value)
    return result


def toc_paths(data):
    top = fields(data)
    need(top.get(4) == [PACKAGE.encode()] and top.get(1), 'TOC package/variant missing')
    sets = [s for v in top[1] for s in fields(v).get(2, [])] + top.get(3, [])
    paths = []
    for apk_set in sets:
        descriptions = fields(apk_set).get(2, [])
        need(descriptions, 'Empty APK set')
        for desc in descriptions:
            p = fields(desc).get(2, [])
            need(len(p) == 1 and type(p[0]) is bytes, 'Missing/duplicate TOC path')
            paths.append(p[0].decode('utf-8'))
    need(paths and len(paths) == len(set(paths)), 'Empty/duplicate TOC APK inventory')
    return set(paths)


def safe_names(z):
    infos = z.infolist()
    names = [x.filename for x in infos]
    need(len(names) == len(set(names)) and len(names) <= 100000, 'Duplicate/oversized ZIP inventory')
    for i in infos:
        p = PurePosixPath(i.filename)
        need(not p.is_absolute() and '..' not in p.parts and '\\' not in i.filename
             and not i.is_dir() and not i.flag_bits & 1
             and (i.external_attr >> 16) & 0o170000 != 0o120000, 'Unsafe ZIP member')
    return set(names)


def inventory(path):
    result = []
    with zipfile.ZipFile(path) as z:
        names = safe_names(z)
        need('toc.pb' in names and z.getinfo('toc.pb').file_size <= 4 * 1024 * 1024, 'Missing/big TOC')
        expected = toc_paths(z.read('toc.pb'))
        need(names == expected | {'toc.pb'} and all(x.endswith('.apk') for x in expected), 'Incomplete/unexpected child archive inventory')
        for name in sorted(expected):
            h = hashlib.sha256()
            with z.open(name) as f:
                for block in iter(lambda: f.read(1024 * 1024), b''):
                    h.update(block)
            with z.open(name) as f, zipfile.ZipFile(f) as child:
                members = safe_names(child)
                need('AndroidManifest.xml' in members, 'Child APK missing manifest')
                for member in child.infolist():
                    with child.open(member) as stream:
                        while stream.read(1024 * 1024):
                            pass  # Read to EOF to validate CRC, with bounded buffers.
            result.append({'path': name, 'size': z.getinfo(name).file_size, 'sha256': h.hexdigest(), 'members': sorted(members)})
    return result


def derive(c, qa, source, work, env, head):
    need('GH_TOKEN' not in env, 'Download token must not enter derivation step')
    verify(work / 'final.aab', SHA, SIZE)
    receipt = load(work / 'download.json')
    need(receipt['sha256'] == SHA and receipt['assetId'] == c['aab']['assetId'], 'Download receipt mismatch')
    tool = work / 'bundletool.jar'
    with urllib.request.urlopen(TOOL_URL, timeout=60) as response, tool.open('xb') as f:
        total = 0
        while block := response.read(1024 * 1024):
            total += len(block)
            need(total <= 64 * 1024 * 1024, 'Bundletool exceeds bound')
            f.write(block)
    verify(tool, TOOL_SHA)
    jdk = Path(env['JAVA_HOME_17_X64'])
    need(jdk.resolve().is_relative_to(Path(env['RUNNER_TOOL_CACHE']).resolve()), 'JDK outside verified cache')
    jreceipt = load(work / 'verified-java.json')
    matching = [x for x in jreceipt['results'] if x['version'] == '17.0.21+9']
    need(len(matching) == 1 and matching[0]['home'] == str(jdk)
         and matching[0]['sha256'] == '8b9b611d917e3dfd8419d3566b5949226f69b052fed7e109c1368add1dfe8711'
         and matching[0]['publisher']['status'] == 'verified', 'Verified JDK17 receipt mismatch')
    need('JAVA_RUNTIME_VERSION="17.0.21+9' in (jdk / 'release').read_text(), 'JDK release mismatch')
    out = work / 'out'
    out.mkdir()
    measurements = []
    def java(args, label):
        home = work / ('empty-home-' + label)
        home.mkdir(mode=0o700)
        measurements.append({'command': label, 'MemAvailable': memory()})
        return run([str(jdk / 'bin/java'), *FLAGS, '-Duser.home=' + str(home), '-jar', str(tool), *args], env=java_env(home))
    java(['validate', '--bundle=' + str(work / 'final.aab')], 'validate')
    manifest = java(['dump', 'manifest', '--bundle=' + str(work / 'final.aab'), '--module=base'], 'manifest')
    import xml.etree.ElementTree as ET
    root = ET.fromstring(manifest)
    android = '{http://schemas.android.com/apk/res/android}'
    need(root.get('package') == PACKAGE and root.get(android + 'versionName') == '1.4.145'
         and root.get(android + 'versionCode') == '157', 'Manifest identity mismatch')
    (out / 'manifest.xml').write_bytes(manifest)
    records = {}
    for role in ROLES:  # Deliberately sequential; no parallel Java processes.
        spec = qa / c['devices'][role]['path']
        target = out / (role + '.UNSIGNED.not-installable.apks')
        java(['build-apks', '--bundle=' + str(work / 'final.aab'), '--output=' + str(target),
              '--device-spec=' + str(spec), '--mode=default', '--max-threads=1'], role)
        records[role] = {'archive': target.name, 'sha256': digest(target), 'size': target.stat().st_size,
                         'specSha256': digest(spec), 'children': inventory(target)}
        (out / (role + '.device-spec.json')).write_bytes(spec.read_bytes())
    # Keep both outputs; no equivalence assumption and no deduplication required.
    verify(work / 'final.aab', SHA, SIZE)
    write(out / 'provenance.json', {'repository': REPO, 'source': SOURCE, 'sourceTree': TREE,
          'qaHead': head, 'workflowRef': env['GITHUB_WORKFLOW_REF'], 'workflowSha': env['GITHUB_WORKFLOW_SHA'],
          'runId': env['GITHUB_RUN_ID'], 'runAttempt': env['GITHUB_RUN_ATTEMPT'],
          'input': receipt, 'identity': {'package': PACKAGE, 'versionName': '1.4.145', 'versionCode': 157},
          'bundletool': {'version': '1.18.3', 'sha256': digest(tool)}, 'jdk': matching[0],
          'jvmFlags': FLAGS, 'maxThreads': 1, 'minimumMemAvailable': FLOOR, 'memory': measurements,
          'devices': records, 'archiveSha256Equal': records['samsung']['sha256'] == records['seeker']['sha256'],
          'signing': 'NOT_PERFORMED; local split signing required', 'signatureVerification': 'NOT_PERFORMED',
          'alignment16K': 'NOT_PERFORMED', 'deviceRuntime': 'NOT_PERFORMED'})


def main():
    need(len(sys.argv) == 5 and sys.argv[1] in ('check', 'download', 'derive'), 'Usage: check|download|derive QA SOURCE WORK')
    mode, qa, source, work = sys.argv[1], *map(lambda x: Path(x).resolve(), sys.argv[2:])
    head = gates(qa, source, os.environ)
    c = config(qa / PREFIX / 'config.json')
    check_specs(c, qa)
    memory()
    if mode == 'download':
        fetch(c, work, os.environ)
    elif mode == 'derive':
        derive(c, qa, source, work, os.environ, head)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        detail = str(error) if isinstance(error, ValueError) else type(error).__name__
        print('REFUSED: ' + detail + '; no fallback or permission broadening.', file=sys.stderr)
        sys.exit(1)
