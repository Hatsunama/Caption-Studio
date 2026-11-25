#!/usr/bin/env python3
"""Owner-dispatched, exact signed-byte verification on isolated GitHub emulators.

No app build, signing, private key, publishing, model download, or physical ADB
target. Download credentials exist only in the separate download step.
"""
import argparse
from contextlib import contextmanager
from enum import Enum
import hashlib
from http.client import IncompleteRead
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

REPO = 'Hatsunama/Caption-Studio'
PACKAGE = 'com.xmilo_at_your_side.caption_studio'
ASSETS = {'solana': 'caption-studio-android.apk', 'play': 'caption-studio-play-universal.apk',
          'aab': 'caption-studio-play-android.aab', 'receipt': 'source-signature-receipt.json'}
ROOT = Path(__file__).resolve().parent.parent
SERIAL = 'emulator-5554'


class Stage(str, Enum):
    CONTEXT = 'context'
    REQUEST = 'request'
    RELEASE = 'release_metadata'
    COMMIT = 'source_commit'
    COMPARE = 'source_compare'
    SOLANA = 'asset_solana'
    PLAY = 'asset_play'
    AAB = 'asset_aab'
    RECEIPT = 'asset_receipt'
    DOWNLOAD = 'download'
    RUNTIME = 'runtime'
    TOOL = 'tool'
    SOLANA_IDENTITY = 'solana_identity'
    SOLANA_SIGNATURE = 'solana_signature'
    PLAY_IDENTITY = 'play_identity'
    PLAY_SIGNATURE = 'play_signature'
    AAB_SIGNATURE = 'aab_signature'
    EMULATOR_SETUP = 'emulator_setup'
    MEDIA_PUSH = 'media_push'
    MEDIA_SCAN = 'media_scan'
    WIFI_DISABLE = 'wifi_disable'
    DATA_DISABLE = 'data_disable'
    AIRPLANE_SETTING = 'airplane_setting'
    AIRPLANE_BROADCAST = 'airplane_broadcast'
    GUEST_OFFLINE = 'guest_offline'
    TRANSFER = 'artifact_transfer'
    TRANSFER_METADATA = 'artifact_metadata'
    IMPORT = 'artifact_validation'


class Reason(str, Enum):
    HTTP = 'http_error'
    TIMEOUT = 'timeout'
    TRANSPORT = 'transport_error'
    TOOL_EXIT = 'tool_exit'
    TOOL_MISSING = 'tool_missing'
    VALIDATION = 'validation'
    REDIRECT = 'unsafe_redirect'
    UNEXPECTED = 'unexpected'


class RuntimeFailure(Exception):
    """Only enum values and bounded integers may enter logs or evidence."""
    def __init__(self, stage, reason, http_status=None, exit_code=None):
        self.stage, self.reason = Stage(stage), Reason(reason)
        self.http_status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
        self.exit_code = exit_code if type(exit_code) is int and -255 <= exit_code <= 255 else None
        super().__init__(self.stage.value+':'+self.reason.value)


@contextmanager
def operation(stage):
    try:
        yield
    except RuntimeFailure:
        raise
    except ValueError:
        raise RuntimeFailure(stage, Reason.VALIDATION) from None
    except Exception:
        raise RuntimeFailure(stage, Reason.UNEXPECTED) from None


class AssetRedirect(HTTPRedirectHandler):
    def __init__(self, stage=Stage.DOWNLOAD):
        self.stage = stage
        super().__init__()

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            target = urlsplit(newurl)
            allowed = (target.scheme == 'https' and target.hostname in
                ('api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'))
            allowed = allowed and target.port in (None, 443) and not target.username and not target.password
        except ValueError:
            allowed = False
        if not allowed:
            raise RuntimeFailure(self.stage, Reason.REDIRECT, http_status=code)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        # Even same-host redirects do not need repository credentials. Never
        # forward Authorization to a signed asset URL or include URLs in errors.
        redirected.remove_header('Authorization')
        return redirected


def http_open(request, timeout):
    # Default TLS verification remains enabled. HTTPError bodies are never read.
    return build_opener(AssetRedirect(getattr(request, 'runtime_stage', Stage.DOWNLOAD))).open(request, timeout=timeout)


def api_get(endpoint, stage, destination=None, max_bytes=2*1024*1024):
    """GET only: retain numeric HTTP status, discard all remote error text."""
    headers = {'Accept': 'application/octet-stream' if destination else 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'caption-studio-runtime-verifier'}
    request = Request('https://api.github.com/repos/'+REPO+'/'+endpoint, headers=headers, method='GET')
    request.runtime_stage = stage
    # Unredirected headers are never copied to another request by urllib.
    request.add_unredirected_header('Authorization', 'Bearer '+os.environ['GH_TOKEN'])
    for attempt in range(3):
        try:
            with http_open(request, timeout=300 if destination else 60) as response:
                if response.status != 200:
                    raise RuntimeFailure(stage, Reason.HTTP, http_status=response.status)
                if destination:
                    total = 0
                    with destination.open('wb') as out:
                        while True:
                            block = response.read(65536)
                            if not block: break
                            total += len(block)
                            require(total <= max_bytes, 'Asset exceeds expected size')
                            out.write(block)
                    return
                body = response.read(max_bytes+1)
                require(len(body) <= max_bytes, 'Metadata response too large')
                return json.loads(body)
        except HTTPError as error:
            status = error.code
            error.close()
            failure = RuntimeFailure(stage, Reason.HTTP, http_status=status)
            retry = status in (429, 500, 502, 503, 504)
        except TimeoutError:
            failure, retry = RuntimeFailure(stage, Reason.TIMEOUT), True
        except URLError as error:
            reason = Reason.TIMEOUT if isinstance(error.reason, TimeoutError) else Reason.TRANSPORT
            failure, retry = RuntimeFailure(stage, reason), True
        except (ConnectionError, IncompleteRead):
            failure, retry = RuntimeFailure(stage, Reason.TRANSPORT), True
        except RuntimeFailure:
            raise
        except ValueError:
            raise RuntimeFailure(stage, Reason.VALIDATION) from None
        except Exception:
            raise RuntimeFailure(stage, Reason.UNEXPECTED) from None
        if not retry or attempt == 2: raise failure from None
        time.sleep(attempt+1)


def require(value, message):
    if not value: raise ValueError(message)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as s:
        for b in iter(lambda: s.read(65536), b''): h.update(b)
    return h.hexdigest()


def run(args, timeout=60, binary=False, stage=Stage.TOOL):
    try:
        result = subprocess.run([str(a) for a in args], check=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
        return result.stdout if binary else result.stdout.decode('utf-8').replace('\r\n', '\n')
    except subprocess.CalledProcessError as error:
        raise RuntimeFailure(stage, Reason.TOOL_EXIT, exit_code=error.returncode) from None
    except subprocess.TimeoutExpired:
        raise RuntimeFailure(stage, Reason.TIMEOUT) from None
    except FileNotFoundError:
        raise RuntimeFailure(stage, Reason.TOOL_MISSING) from None
    except Exception:
        raise RuntimeFailure(stage, Reason.UNEXPECTED) from None


def workflow_request():
    """Original dispatch inputs, never imported artifact claims."""
    with operation(Stage.REQUEST):
        request = {k.lower(): os.environ.get(k, '') for k in
                   ['RELEASE_ID', 'EXPECTED_SOURCE_COMMIT'] +
                   [r.upper()+s for r in ASSETS for s in ('_ASSET_ID', '_SHA256')]}
        require(re.fullmatch(r'[1-9][0-9]*', request['release_id']), 'Canonical release ID required')
        require(re.fullmatch('[0-9a-f]{40}', request['expected_source_commit']), 'Exact source commit required')
        require(re.fullmatch('[0-9a-f]{40}', os.environ.get('GITHUB_SHA', '')), 'Exact workflow commit required')
        for role in ASSETS:
            require(re.fullmatch(r'[1-9][0-9]*', request[role+'_asset_id']), 'Canonical asset ID required')
            require(re.fullmatch('[0-9a-f]{64}', request[role+'_sha256']), 'Canonical asset hash required')
        require(len({request[r+'_asset_id'] for r in ASSETS}) == len(ASSETS), 'Duplicate asset ID')
        return request


def validate_public_source(request):
    """Independently bind the receipt tree and ancestry to public GitHub data."""
    commit = api_get('commits/'+request['expected_source_commit'], Stage.COMMIT)
    with operation(Stage.COMMIT):
        require(commit.get('sha') == request['expected_source_commit'], 'Wrong public source commit')
        tree = commit['commit']['tree']['sha']
        require(re.fullmatch('[0-9a-f]{40}', tree), 'Exact source tree required')
        require(request.get('source_tree', tree) == tree, 'Imported source tree differs from public commit')
        request['source_tree'] = tree
    comparison = api_get('compare/'+request['expected_source_commit']+'...'+os.environ['GITHUB_SHA'], Stage.COMPARE)
    with operation(Stage.COMPARE):
        require(comparison.get('status') in ('ahead', 'identical'), 'Source must be in dispatched main history')


def validate_import(directory, expected):
    """Reject links/extra paths before reading metadata, hashing, or invoking tools."""
    with operation(Stage.IMPORT):
        require(stat.S_ISDIR(directory.lstat().st_mode), 'Canonical import directory required')
        entries = list(directory.iterdir())
        require({p.name for p in entries} == set(ASSETS.values()) | {'request.json'}, 'Noncanonical import files')
        for p in entries:
            info = p.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Import must contain plain independent files')
            cap = 65536 if p.name == 'request.json' else (1024*1024 if p.name == ASSETS['receipt'] else 1024**3)
            require(0 < info.st_size <= cap, 'Import file size outside bounds')
        request = json.loads((directory/'request.json').read_text())
        require(type(request) is dict and set(request) == set(expected) | {'source_tree'}, 'Canonical request schema required')
        require(all(request[k] == v for k, v in expected.items()), 'Import differs from original workflow inputs')
        require(re.fullmatch('[0-9a-f]{40}', request['source_tree']), 'Canonical imported source tree required')
        for role, name in ASSETS.items():
            require(sha(directory/name) == expected[role+'_sha256'], 'Import hash differs from original workflow input')
        return request


def receive(directory):
    with operation(Stage.CONTEXT):
        assert_context(os.environ)
        require(os.environ.get('GH_TOKEN'), 'Read-only artifact retrieval token required')
    expected = workflow_request()
    with operation(Stage.REQUEST):
        run_id, attempt = os.environ.get('GITHUB_RUN_ID', ''), os.environ.get('GITHUB_RUN_ATTEMPT', '')
        artifact_id = os.environ.get('PREPARE_ARTIFACT_ID', '')
        require(all(re.fullmatch(r'[1-9][0-9]*', v) for v in (run_id, attempt, artifact_id)),
                'Canonical same-run artifact identity required')
        # A failed-job rerun can reuse a successful prepare from an earlier
        # attempt. Trust only that job's exported name, then bind it to this run
        # and to the immutable ID/server metadata below.
        name = os.environ.get('PREPARE_ARTIFACT_NAME', '')
        producer = re.fullmatch('final-signed-inputs-'+run_id+r'-([1-9][0-9]*)', name)
        require(producer and int(producer[1]) <= int(attempt),
                'Canonical same-run prepare attempt must not be in the future')
    artifact = api_get('actions/artifacts/'+artifact_id, Stage.TRANSFER_METADATA)
    with operation(Stage.TRANSFER_METADATA):
        require(artifact.get('id') == int(artifact_id) and artifact.get('name') == name and
                artifact.get('expired') is False and
                artifact.get('workflow_run', {}).get('id') == int(run_id) and
                artifact.get('workflow_run', {}).get('head_sha') == os.environ['GITHUB_SHA'],
                'Artifact must be the immutable prepare output of this exact run')
    with operation(Stage.TRANSFER):
        directory.mkdir()  # Exclusive destination; no old ready marker.
        # Only same run + validated producer name, never an arbitrary source.
        # Child output is captured; CLI failures retain exit code without
        # guessing an HTTP status from potentially secret-bearing stderr.
        run(['gh', 'run', 'download', run_id, '--repo', REPO, '--name', name,
             '--dir', directory], timeout=600, stage=Stage.TRANSFER)
    imported = validate_import(directory, expected)
    validate_public_source(imported)


def assert_context(env):
    for k, value in dict(GITHUB_ACTIONS='true', GITHUB_EVENT_NAME='workflow_dispatch',
                        GITHUB_REPOSITORY=REPO, GITHUB_REPOSITORY_OWNER='Hatsunama',
                        GITHUB_ACTOR='Hatsunama', GITHUB_TRIGGERING_ACTOR='Hatsunama',
                        GITHUB_REF='refs/heads/main',
                        GITHUB_WORKFLOW_REF=REPO+'/.github/workflows/verify-final-android-runtime.yml@refs/heads/main').items():
        require(env.get(k) == value, 'Unauthorized runtime verification context: '+k)


def validate_assets(request, release):
    require(re.fullmatch(r'[1-9][0-9]*', request.get('release_id', '')), 'Canonical release ID required')
    commit = request.get('expected_source_commit', '')
    require(re.fullmatch('[0-9a-f]{40}', commit), 'Exact source commit required')
    require(release.get('id') == int(request['release_id']) and release.get('draft') is True and
            release.get('author', {}).get('login') == 'Hatsunama' and release.get('target_commitish') == commit,
            'Owner draft release must target exact source commit')
    ids = set()
    for role, name in ASSETS.items():
        asset_id, expected = request.get(role+'_asset_id', ''), request.get(role+'_sha256', '')
        require(re.fullmatch(r'[1-9][0-9]*', asset_id) and re.fullmatch('[0-9a-f]{64}', expected), 'Canonical asset ID/hash required')
        require(asset_id not in ids, 'Duplicate asset ID'); ids.add(asset_id)
        matches = [a for a in release.get('assets', []) if a.get('id') == int(asset_id)]
        require(len(matches) == 1, 'Asset not in exact draft release')
        a = matches[0]
        require(a.get('name') == name and a.get('state') == 'uploaded' and type(a.get('size')) is int and
                0 < a['size'] <= (1024*1024 if role == 'receipt' else 1024*1024*1024), 'Wrong draft asset name/state/size')
        require(a.get('digest') in (None, 'sha256:'+expected), 'GitHub asset digest mismatch')


def download(directory):
    with operation(Stage.CONTEXT):
        assert_context(os.environ)
        require(os.environ.get('GH_TOKEN'), 'GH_TOKEN required only in download step')
    request = workflow_request()
    release = api_get('releases/'+request['release_id'], Stage.RELEASE)
    with operation(Stage.RELEASE):
        validate_assets(request, release)
    validate_public_source(request)
    directory.mkdir()  # Exclusive ownership; a partial download is never ready.
    for role, name in ASSETS.items():
        p = directory/name
        meta = next(a for a in release['assets'] if a['id'] == int(request[role+'_asset_id']))
        stage = Stage('asset_'+role)
        with operation(stage):
            api_get('releases/assets/'+request[role+'_asset_id'], stage, p, meta['size'])
            require(sha(p) == request[role+'_sha256'], 'Downloaded asset hash mismatch: '+role)
            require(p.stat().st_size == meta['size'], 'Downloaded asset size mismatch')
    (directory/'request.json').write_text(json.dumps(request, sort_keys=True))


def member_hashes(z, mapping):
    result = {}
    require(len(z.namelist()) == len(set(z.namelist())), 'Duplicate ZIP entries')
    for i in z.infolist():
        target = mapping(i.filename)
        if target is None: continue
        require(target not in result, 'Duplicate derived payload path')
        h = hashlib.sha256()
        with z.open(i) as s:
            for b in iter(lambda: s.read(65536), b''): h.update(b)
        result[target] = h.hexdigest()
    return result


def assert_derived_payload(aab, apk):
    def mapped(n):
        if n.startswith(('base/lib/', 'base/assets/')) and not n.endswith('/'): return n[5:]
        if re.fullmatch(r'base/dex/classes[0-9]*\.dex', n): return n[9:]
        if n in ('BUNDLE-METADATA/com.android.tools.build.profiles/baseline.prof',
                  'BUNDLE-METADATA/com.android.tools.build.profiles/baseline.profm'):
            return 'assets/dexopt/'+n.rsplit('/', 1)[1]
    def selected(n):
        if n.startswith(('lib/', 'assets/')) and not n.endswith('/') or re.fullmatch(r'classes[0-9]*\.dex', n): return n
    with zipfile.ZipFile(aab) as z: expected = member_hashes(z, mapped)
    with zipfile.ZipFile(apk) as z: actual = member_hashes(z, selected)
    require(expected and expected == actual, 'AAB-derived APK native/dex/asset payload differs')


def identity(badging):
    match = re.search(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'", badging, re.M)
    minimum = re.search(r"^sdkVersion:'([0-9]+)'", badging, re.M)
    target = re.search(r"^targetSdkVersion:'([0-9]+)'", badging, re.M)
    require(match and minimum and target, 'Missing binary identity')
    return dict(package=match[1], versionCode=int(match[2]), version=match[3], minSdk=int(minimum[1]), targetSdk=int(target[1]))


def verify_files(directory, tools):
    request = json.loads((directory/'request.json').read_text())
    for role, name in ASSETS.items(): require(sha(directory/name) == request[role+'_sha256'], 'Asset changed after download')
    receipt = json.loads((directory/ASSETS['receipt']).read_text())
    require(receipt.get('schemaVersion') == 1 and receipt.get('repository') == REPO and
            receipt.get('sourceCommit') == request['expected_source_commit'] and
            re.fullmatch('[0-9a-f]{40}', receipt.get('sourceTree', '')) and
            receipt['sourceTree'] == request.get('source_tree'), 'Signed receipt source identity mismatch')
    require(receipt.get('package') == PACKAGE and type(receipt.get('versionCode')) is int, 'Signed receipt product identity mismatch')
    for role, key in (('solana', 'apk'), ('aab', 'aab')):
        require(receipt.get('payloads', {}).get(key, {}).get('sha256') == request[role+'_sha256'], 'Signed receipt binary hash mismatch')
    product = json.loads((ROOT/'config/product-contract.json').read_text())
    signing = json.loads((ROOT/'config/local-signing-contract.json').read_text())
    require(receipt.get('certificates') == signing['roles'] and signing['roles']['apk'] == product['android']['release']['signingCertificateSha256'], 'Signing roles mismatch')
    expected = dict(package=PACKAGE, versionCode=receipt['versionCode'], version=receipt['version'], minSdk=24, targetSdk=36)
    for role, pin in (('solana', signing['roles']['apk']), ('play', signing['roles']['aab'])):
        file = directory/ASSETS[role]
        require(identity(run([tools/'aapt', 'dump', 'badging', file], stage=Stage(role+'_identity'))) == expected, 'APK identity mismatch')
        cert = run(['java', '-Xms16m', '-Xmx128m', '-XX:ActiveProcessorCount=1', '-jar', tools/'lib/apksigner.jar', 'verify', '--verbose', '--print-certs', file], stage=Stage(role+'_signature'))
        pins = re.findall(r'^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-fA-F]+)$', cert, re.M)
        require([p.lower() for p in pins] == [pin] and re.search(r'^Verified using v2 scheme .*: true$', cert, re.M), 'APK signature mismatch')
    require(run(['java', '-Xms16m', '-Xmx96m', '-XX:ActiveProcessorCount=1',
                 ROOT/'scripts/verify-android-native-compatibility-runtime.java',
                 directory/ASSETS['aab'], signing['roles']['aab']], stage=Stage.AAB_SIGNATURE).strip() == 'VERIFIED', 'AAB signature verification failed')
    assert_derived_payload(directory/ASSETS['aab'], directory/ASSETS['play'])
    return request, receipt


def find_control(xml, label, package):
    root = ET.fromstring(xml); parents = {c: p for p in root.iter() for c in p}
    matches = {}
    for n in root.iter('node'):
        if label not in (n.get('text'), n.get('content-desc')): continue
        chain = []; p = n
        while p is not None:
            chain.append(p); p = parents.get(p)
        actual_package = next((p.get('package') for p in chain if p.get('package')), None)
        if package and actual_package != package: continue
        bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', n.get('bounds', ''))
        require(bounds, 'Missing UI control bounds')
        x1, y1, x2, y2 = map(int, bounds.groups())
        require(x2 > x1 and y2 > y1 and x2 <= 4096 and y2 <= 4096, 'Invalid UI bounds')
        matches[(x1, y1, x2, y2)] = dict(enabled=not any(p.get('enabled') == 'false' for p in chain),
                                      clickable=any(p.get('clickable') == 'true' for p in chain),
                                      x=(x1+x2)//2, y=(y1+y2)//2)
    require(len(matches) == 1, 'UI control missing/ambiguous: '+label)
    return next(iter(matches.values()))


def configure_emulator(adb):
    for setting in ('window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'):
        adb('shell', 'settings', 'put', 'global', setting, '0.0', timeout=10)
    adb('shell', 'settings', 'put', 'secure', 'spell_checker_enabled', '0', timeout=10)

def guest_network_is_offline(snapshot):
    if len(snapshot) > 1024*1024:
        return False
    defaults = re.findall(r'^Active default network: (\S+)\s*$', snapshot, re.M)
    sections = re.findall(r'^Current Networks:\s*\n(.*?)^Network Requests:', snapshot, re.M | re.S)
    return defaults == ['none'] and len(sections) == 1 and not sections[0].strip()


def verify_guest_offline(adb):
    for attempt in range(10):
        airplane = adb('shell', 'settings', 'get', 'global', 'airplane_mode_on', timeout=5, stage=Stage.GUEST_OFFLINE)
        connectivity = adb('shell', 'dumpsys', 'connectivity', '--short', timeout=5, stage=Stage.GUEST_OFFLINE)
        if airplane.strip() == '1' and guest_network_is_offline(connectivity):
            return
        if attempt < 9:
            time.sleep(1)
    raise RuntimeFailure(Stage.GUEST_OFFLINE, Reason.VALIDATION)

def prepare_fixture_for_import(adb, tiny):
    adb('push', tiny, '/sdcard/Download/ci-tiny.mp4', stage=Stage.MEDIA_PUSH)
    adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file:///sdcard/Download/ci-tiny.mp4', stage=Stage.MEDIA_SCAN)
    adb('shell', 'settings', 'put', 'global', 'airplane_mode_radios', 'cell,bluetooth,wifi,nfc,wimax', stage=Stage.AIRPLANE_SETTING)
    adb('shell', 'settings', 'put', 'global', 'airplane_mode_toggleable_radios', 'none', stage=Stage.AIRPLANE_SETTING)
    adb('shell', 'settings', 'put', 'global', 'airplane_mode_on', '1', stage=Stage.AIRPLANE_SETTING)
    adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', 'true', stage=Stage.AIRPLANE_BROADCAST)
    verify_guest_offline(adb)

def emulate(directory, evidence, api, arch, tools):
    assert_context(os.environ)
    require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'Download token must not reach runtime step')
    require((api, arch) in ((24, 'x86'), (25, 'x86_64'), (26, 'x86_64')), 'Unknown emulator matrix cell')
    validate_import(directory, workflow_request())
    request, receipt = verify_files(directory, tools)
    devices = run(['adb', 'devices']).splitlines()[1:]
    require([s.split() for s in devices if s.strip()] == [[SERIAL, 'device']], 'Only one isolated emulator permitted')

    def adb(*args, timeout=30, binary=False, stage=Stage.RUNTIME):
        return run(['adb', '-s', SERIAL, *args], timeout, binary, stage=stage)

    require(adb('shell', 'getprop', 'ro.kernel.qemu').strip() == '1', 'Physical target refused')
    require(adb('shell', 'getprop', 'ro.build.version.sdk').strip() == str(api), 'Wrong emulator API')
    abis = adb('shell', 'getprop', 'ro.product.cpu.abilist').strip().split(',')
    require(arch in abis and (arch != 'x86' or 'x86_64' not in abis), 'Wrong emulator ABI')
    meminfo = adb('shell', 'cat', '/proc/meminfo')
    memory = int(re.search(r'^MemTotal:\s+([0-9]+) kB', meminfo, re.M)[1])*1024
    if api >= 25:
        require(memory >= 4*1024**3 and adb('shell', 'getprop', 'ro.config.low_ram').strip() != 'true', 'Qualifying 64-bit >=4GiB guest required')
    else: require(memory < 4*1024**3, 'API24 must exercise low-memory fallback')
    configure_emulator(lambda *args, **kwargs: adb(*args, stage=Stage.EMULATOR_SETUP, **kwargs))
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence/'hardware.json').write_text(json.dumps(dict(api=api, abis=abis, memoryBytes=memory)))
    tiny = evidence/'ci-tiny.mp4'
    run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=10', '-t', '1',
         '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', tiny])
    prepare_fixture_for_import(adb, tiny)
    (evidence/'offline.json').write_text(json.dumps(dict(airplaneMode=True, activeDefaultNetwork=False, currentNetworks=0)))
    results = []
    for role in ('solana', 'play'):
        verify_guest_offline(adb)
        folder = evidence/role; folder.mkdir()
        # Distinct signing certificates require a clean uninstall between roles.
        if 'package:'+PACKAGE in adb('shell', 'pm', 'list', 'packages', PACKAGE):
            require('Success' in adb('shell', 'pm', 'uninstall', PACKAGE), 'Old test package uninstall failed')
        require('Success' in adb('install', '--no-streaming', directory/ASSETS[role], timeout=180), 'APK installation failed')
        adb('logcat', '-c')
        start = time.monotonic()
        snapshots = 0

        def snapshot():
            nonlocal snapshots
            adb('shell', 'uiautomator', 'dump', '/sdcard/caption-runtime.xml', timeout=20)
            xml = adb('exec-out', 'cat', '/sdcard/caption-runtime.xml')
            require(len(xml) <= 2*1024*1024, 'UI snapshot too large')
            ET.fromstring(xml); snapshots += 1
            (folder/f'{snapshots:02d}.xml').write_text(xml)
            return xml

        def wait(label, package=PACKAGE, seconds=60):
            deadline = time.monotonic()+seconds; error = None
            while time.monotonic() < deadline:
                try:
                    xml = snapshot()
                    try: return find_control(xml, label, package)
                    except ValueError:
                        # Cancellation is the only consent action permitted.
                        # Never press a download/accept button during this test.
                        for cancel in ('Not now', 'NOT NOW'):
                            try: control = find_control(xml, cancel, None)
                            except ValueError: continue
                            tap(control); break
                        raise
                except (ValueError, RuntimeFailure) as caught:
                    error = caught; time.sleep(1)
            raise ValueError('Timed out waiting for '+label) from error

        def tap(control):
            require(control['enabled'] and control['clickable'], 'UI control not usable')
            adb('shell', 'input', 'tap', str(control['x']), str(control['y']))

        try:
            require('Status: ok' in adb('shell', 'am', 'start', '-W', '-n', PACKAGE+'/.MainActivity', timeout=60), 'First launch failed')
            home = wait('Import a video')
            require(home['enabled'] and home['clickable'], 'Home import control is not usable')
            first_home = round(time.monotonic()-start, 3)
            require(adb('shell', 'pidof', PACKAGE).strip(), 'App process died on Home')
            # A second live snapshot excludes a single stale startup frame.
            tap(wait('Import a video'))
            try: video = wait('ci-tiny.mp4', package=None, seconds=12)
            except ValueError:
                menu = wait('Show roots', package=None, seconds=10); tap(menu)
                tap(wait('Downloads', package=None, seconds=10))
                video = wait('ci-tiny.mp4', package=None, seconds=20)
            tap(video)
            tap(wait('Captions', seconds=90))
            dual = wait('Dual subtitles', seconds=60)
            require(dual['enabled'] == (api == 26), 'Wrong Dual subtitles capability admission')
            if api == 26:
                tap(dual)
                # With no captions/model this alert proves the enabled action was
                # actually dispatched. It must not start model acquisition.
                wait('Generate captions first', package=None, seconds=15)
                try: tap(find_control(snapshot(), 'OK', None))
                except ValueError:
                    tap(wait('Not now', package=None, seconds=10))
            require(adb('shell', 'pidof', PACKAGE).strip(), 'App process died after import/capability check')
            results.append(dict(role=role, apkSha256=request[role+'_sha256'], firstUsableHomeSeconds=first_home,
                                importedTinyVideo=True, dualSubtitlesEnabled=dual['enabled'], status='passed'))
        finally:
            (folder/'screen.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
            logs = adb('logcat', '-d', '-v', 'threadtime')
            (folder/'logcat.txt').write_text(logs)
            require(not re.search(r'UnsatisfiedLinkError|cannot locate symbol|FATAL EXCEPTION', logs), 'Runtime crash/linker failure in isolated emulator')
    report = dict(schemaVersion=1, status='passed', sourceCommit=request['expected_source_commit'],
                  workflowCommit=os.environ['GITHUB_SHA'], api=api, arch=arch, memoryBytes=memory,
                  receiptSha256=request['receipt_sha256'], signedAabSha256=request['aab_sha256'], runs=results)
    (evidence/'runtime-result.json').write_text(json.dumps(report, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=('download', 'receive', 'run'))
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--evidence', type=Path); p.add_argument('--api', type=int)
    p.add_argument('--arch'); p.add_argument('--build-tools', type=Path)
    args = p.parse_args()
    try:
        with operation(Stage.REQUEST):
            require(args.evidence, 'Evidence required for both lifecycle modes')
        with operation(Stage.RUNTIME if args.mode == 'run' else Stage.DOWNLOAD):
            if args.mode == 'download': download(args.directory)
            elif args.mode == 'receive': receive(args.directory)
            else:
                require(args.build_tools, 'Build-tools required')
                emulate(args.directory, args.evidence, args.api, args.arch, args.build_tools)
        return 0
    except RuntimeFailure as error:
        record = dict(schemaVersion=1, status='failed', mode=args.mode,
                      stage=error.stage.value, reason=error.reason.value,
                      httpStatus=error.http_status, exitCode=error.exit_code)
        # No exception messages, child stdout/stderr, URLs, headers, or tokens.
        try:
            args.evidence.mkdir(parents=True, exist_ok=True)
            (args.evidence/'runtime-failure.json').write_text(json.dumps(record, sort_keys=True))
        except Exception:
            pass  # Even evidence I/O failure must never dump exception text.
        print(json.dumps(record, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
