#!/usr/bin/env python3
"""Owner-dispatched, exact signed-byte verification on isolated GitHub emulators.

No app build, signing, private key, publishing, model download, or physical ADB
target. Download credentials exist only in the separate download step.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

REPO = 'Hatsunama/Caption-Studio'
PACKAGE = 'com.xmilo_at_your_side.caption_studio'
ASSETS = {'solana': 'caption-studio-android.apk', 'play': 'caption-studio-play-universal.apk',
          'aab': 'caption-studio-play-android.aab', 'receipt': 'source-signature-receipt.json'}
ROOT = Path(__file__).resolve().parent.parent
SERIAL = 'emulator-5554'


def require(value, message):
    if not value: raise ValueError(message)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as s:
        for b in iter(lambda: s.read(65536), b''): h.update(b)
    return h.hexdigest()


def run(args, timeout=60, binary=False):
    result = subprocess.run([str(a) for a in args], check=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    return result.stdout if binary else result.stdout.decode('utf-8')


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
    assert_context(os.environ)
    require(os.environ.get('GH_TOKEN'), 'Read-only GH_TOKEN required in download step')
    request = {k.lower(): os.environ.get(k, '') for k in
               ['RELEASE_ID', 'EXPECTED_SOURCE_COMMIT'] + [r.upper()+s for r in ASSETS for s in ('_ASSET_ID', '_SHA256')]}
    require(re.fullmatch(r'[1-9][0-9]*', request['release_id']), 'Canonical release ID required')
    release = json.loads(run(['gh', 'api', f'repos/{REPO}/releases/{request["release_id"]}']))
    validate_assets(request, release)
    commit = json.loads(run(['gh', 'api', f'repos/{REPO}/commits/{request["expected_source_commit"]}']))
    require(commit.get('sha') == request['expected_source_commit'], 'Source commit not in expected repository')
    request['source_tree'] = commit['commit']['tree']['sha']
    require(re.fullmatch('[0-9a-f]{40}', os.environ.get('GITHUB_SHA', '')), 'Exact workflow commit required')
    comparison = json.loads(run(['gh', 'api', f'repos/{REPO}/compare/{request["expected_source_commit"]}...{os.environ["GITHUB_SHA"]}']))
    require(comparison.get('status') in ('ahead', 'identical'), 'Binary source commit must be in dispatched main history')
    directory.mkdir()  # Exclusive ownership; a partial download is never ready.
    for role, name in ASSETS.items():
        p = directory/name
        with p.open('xb') as out:
            subprocess.run(['gh', 'api', '-H', 'Accept: application/octet-stream',
                            f'repos/{REPO}/releases/assets/{request[role+"_asset_id"]}'], stdout=out,
                           stderr=subprocess.PIPE, check=True, timeout=300)
        require(sha(p) == request[role+'_sha256'], 'Downloaded asset hash mismatch: '+role)
        meta = next(a for a in release['assets'] if a['id'] == int(request[role+'_asset_id']))
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
        require(identity(run([tools/'aapt', 'dump', 'badging', file])) == expected, 'APK identity mismatch')
        cert = run([tools/'apksigner', 'verify', '--verbose', '--print-certs', file])
        pins = re.findall(r'^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-fA-F]+)$', cert, re.M)
        require([p.lower() for p in pins] == [pin] and re.search(r'^Verified using v2 scheme .*: true$', cert, re.M), 'APK signature mismatch')
    require(run(['java', '-Xms16m', '-Xmx96m', '-XX:ActiveProcessorCount=1',
                 ROOT/'scripts/verify-android-native-compatibility-runtime.java',
                 directory/ASSETS['aab'], signing['roles']['aab']]).strip() == 'VERIFIED', 'AAB signature verification failed')
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


def emulate(directory, evidence, api, arch, tools):
    assert_context(os.environ)
    require(not os.environ.get('GH_TOKEN'), 'Download token must not reach runtime step')
    require((api, arch) in ((24, 'x86'), (25, 'x86_64'), (26, 'x86_64')), 'Unknown emulator matrix cell')
    request, receipt = verify_files(directory, tools)
    devices = run(['adb', 'devices']).splitlines()[1:]
    require([s.split() for s in devices if s.strip()] == [[SERIAL, 'device']], 'Only one isolated emulator permitted')

    def adb(*args, timeout=30, binary=False):
        return run(['adb', '-s', SERIAL, *args], timeout, binary)

    require(adb('shell', 'getprop', 'ro.kernel.qemu').strip() == '1', 'Physical target refused')
    require(adb('shell', 'getprop', 'ro.build.version.sdk').strip() == str(api), 'Wrong emulator API')
    abis = adb('shell', 'getprop', 'ro.product.cpu.abilist').strip().split(',')
    require(arch in abis and (arch != 'x86' or 'x86_64' not in abis), 'Wrong emulator ABI')
    meminfo = adb('shell', 'cat', '/proc/meminfo')
    memory = int(re.search(r'^MemTotal:\s+([0-9]+) kB', meminfo, re.M)[1])*1024
    if api >= 25:
        require(memory >= 4*1024**3 and adb('shell', 'getprop', 'ro.config.low_ram').strip() != 'true', 'Qualifying 64-bit >=4GiB guest required')
    else: require(memory < 4*1024**3, 'API24 must exercise low-memory fallback')
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence/'hardware.json').write_text(json.dumps(dict(api=api, abis=abis, memoryBytes=memory)))
    tiny = evidence/'ci-tiny.mp4'
    run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=10', '-t', '1',
         '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', tiny])
    adb('push', tiny, '/sdcard/Download/ci-tiny.mp4')
    adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file:///sdcard/Download/ci-tiny.mp4')
    adb('shell', 'svc', 'wifi', 'disable'); adb('shell', 'svc', 'data', 'disable')
    adb('shell', 'settings', 'put', 'global', 'airplane_mode_on', '1')
    adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', 'true')
    results = []
    for role in ('solana', 'play'):
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
                except (ValueError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as caught:
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
    p.add_argument('mode', choices=('download', 'run'))
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--evidence', type=Path); p.add_argument('--api', type=int)
    p.add_argument('--arch'); p.add_argument('--build-tools', type=Path)
    args = p.parse_args()
    if args.mode == 'download': download(args.directory)
    else:
        require(args.evidence and args.build_tools, 'Evidence/build-tools required')
        try: emulate(args.directory, args.evidence, args.api, args.arch, args.build_tools)
        except Exception as error:
            args.evidence.mkdir(parents=True, exist_ok=True)
            (args.evidence/'runtime-failure.json').write_text(json.dumps(dict(status='failed',
                error=type(error).__name__, reason=str(error) if isinstance(error, ValueError) else 'Tool execution failed')))
            raise


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # GH CLI errors may contain authenticated URLs; never print child output.
        print('Final signed-byte runtime verification FAILED: '+type(error).__name__, file=sys.stderr)
        sys.exit(1)
