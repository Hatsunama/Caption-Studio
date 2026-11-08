import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JAVA_RELEASES, PUBLIC_KEY_SHA256, PUBLIC_KEY_FINGERPRINT, downloadUrl, assertSignatureStatus, verifyFile } from '../scripts/build-toolchain/verified-java-download.mjs';
const fpr = '3B04D753C9050D9A5D343F39843C48A565F8F04B';
const good = `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG 843C48A565F8F04B Adoptium\n[GNUPG:] VALIDSIG ${fpr} 2026-10-22 1792627200 0 4 0 1 8 00 ${fpr}\n`;
test('manual transport retains exact signed Temurin builds and TLS release origin', () => {
    assert.equal(JAVA_RELEASES[21].version, '21.0.13+9');
    assert.equal(JAVA_RELEASES[17].version, '17.0.21+9');
    for (const a of Object.values(JAVA_RELEASES)) {
        const u = new URL(downloadUrl(a));
        assert.equal(u.protocol, 'https:');
        assert.equal(u.hostname, 'api.adoptium.net');
        assert.match(u.pathname, /^\/v3\/binary\/version\/jdk-(?:17|21)\./);
        const sig = new URL(downloadUrl(a, true));
        assert.equal(sig.hostname, 'github.com');
        assert.match(sig.pathname, /^\/adoptium\/temurin(?:17|21)-binaries\/releases\/download\//);
        assert.equal(sig.searchParams.get('download'), '1');
        assert.match(a.sha256, /^[a-f0-9]{64}$/);
        assert.ok(a.bytes > 190000000);
        assert.equal(a.sigBytes, 310);
    }
    const key = fs.readFileSync(new URL('../scripts/build-toolchain/adoptium-public.asc', import.meta.url));
    assert.equal(createHash('sha256').update(key).digest('hex'), PUBLIC_KEY_SHA256);
    assert.equal(PUBLIC_KEY_FINGERPRINT, fpr);
    assert.match(key.toString(), /BEGIN PGP PUBLIC KEY BLOCK/);
    assert.doesNotMatch(key.toString(), /PRIVATE KEY/);
});
test('signature requires a single valid pinned signer and SHA256 or stronger', () => {
    assert.doesNotThrow(() => assertSignatureStatus(good, 0));
    for (const bad of [good.replace(fpr, 'A'.repeat(40)), good.replace(' 1 8 00 ', ' 1 2 00 '), good + good, good + '[GNUPG:] EXPKEYSIG key expired\n', good + '[GNUPG:] REVKEYSIG key revoked\n', good + '[GNUPG:] BADSIG key\n', '[GNUPG:] GOODSIG key only\n'])
        assert.throws(() => assertSignatureStatus(bad, 0));
    assert.throws(() => assertSignatureStatus(good, 1));
});
test('integrity rejects truncated, tampered, oversized and linked input before use', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-java-integrity-'));
    try {
        const f = path.join(dir, 'archive');
        fs.writeFileSync(f, 'abc');
        const hash = createHash('sha256').update('abc').digest('hex');
        await verifyFile(f, 3, hash);
        await assert.rejects(verifyFile(f, 4, hash));
        await assert.rejects(verifyFile(f, 2, hash));
        await assert.rejects(verifyFile(f, 3, '0'.repeat(64)));
        await assert.rejects(verifyFile(dir, 3, hash));
        const link = path.join(dir, 'linked');
        fs.linkSync(f, link);
        await assert.rejects(verifyFile(f, 3, hash));
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('range transport rejects wrong offsets, totals, oversized responses and HTTPS downgrade', async () => {
    const { spawnSync } = await import('node:child_process');
    const python = process.platform === 'win32' ? 'C:\\Python311\\python.exe' : 'python3';
    const code = `import importlib.util, pathlib, urllib.request
p=pathlib.Path('scripts/build-toolchain/ranged-download.py');spec=importlib.util.spec_from_file_location('transport',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.validate_response(206,{'Content-Range':'bytes 0-7/16'},0,7,16)
m.validate_response(200,{},0,7,8)
for status,h,a,b,n in [(206,{'Content-Range':'bytes 8-15/16'},0,7,16),(206,{'Content-Range':'bytes 0-7/17'},0,7,16),(200,{},0,7,16),(206,{'Content-Range':'bytes 0-7/16','Content-Encoding':'gzip'},0,7,16)]:
 try:m.validate_response(status,h,a,b,n)
 except ValueError:pass
 else:raise AssertionError('Bad range accepted')
try:m.SecureRedirect().redirect_request(urllib.request.Request('https://example.com'),None,302,'',{},'http://example.com/file')
except ValueError:pass
else:raise AssertionError('HTTPS downgrade accepted')
`;
    const r = spawnSync(python, ['-I', '-B', '-c', code], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, (r.stderr ?? '') + String(r.error ?? ''));
});
test('every manual Java bootstrap hardens both verified JDKs before any consumer', async () => {
    const { parse } = await import('yaml');
    let count = 0;
    for (const name of fs.readdirSync(new URL('../.github/workflows/', import.meta.url)).filter(x => x.endsWith('.yml'))) {
        const source = fs.readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
        if (!source.includes('scripts/build-toolchain/verified-java-download.mjs --install'))
            continue;
        const doc = parse(source);
        for (const job of Object.values(doc.jobs ?? {})) {
            const steps = job.steps ?? [];
            for (let i = 0; i < steps.length; i++) {
                if (!String(steps[i].run ?? '').includes('scripts/build-toolchain/verified-java-download.mjs --install'))
                    continue;
                count++;
                assert.match(steps[i].run, /--install "\$RUNNER_TOOL_CACHE" --receipt "\$GITHUB_WORKSPACE\/evidence\/verified-java.json"/);
                assert.equal(steps[i + 1].name, 'Harden and verify Java trust stores');
                assert.equal(steps[i + 1].run, 'node scripts/harden-java-truststores.mjs --ci');
                assert.ok(steps.slice(0, i).every(x => !String(x.run ?? '').match(/gradlew|keytool|npm ci/)), 'No consuming build or dependency install before hardening');
            }
        }
    }
    assert.ok(count > 0, 'No covered manual verified JDK bootstrap');
});
test('actual transport handles small signatures and ordered bounded multi-range writes', async () => {
    const { spawnSync } = await import('node:child_process');
    const python = process.platform === 'win32' ? 'C:\\Python311\\python.exe' : 'python3';
    const code = `import importlib.util,pathlib,tempfile,urllib.request,time,threading
spec=importlib.util.spec_from_file_location('transport',pathlib.Path('scripts/build-toolchain/ranged-download.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
lock=threading.Lock();active=0;peak=0;payload=b'';bad=False
class Reply:
 def __init__(self,req):
  self.a,self.b=map(int,req.get_header('Range').removeprefix('bytes=').split('-'));self.status=206;self.headers={'Content-Range':f'bytes {self.a}-{self.b}/{len(payload)}'}
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,n):
  global active,peak
  with lock:active+=1;peak=max(peak,active)
  if self.a==0:time.sleep(.02)
  data=payload[self.a:self.b+1]
  with lock:active-=1
  return data[:-1] if bad else data
class Opener:
 def open(self,req,timeout):return Reply(req)
m.urllib.request.build_opener=lambda *args:Opener()
with tempfile.TemporaryDirectory(prefix='cs-java-range-test-') as root:
 m.CHUNK=4
 for i,data in enumerate([b'abc',b'ABCDEFGHIJKLMNOPQ']):
  payload=data;f=pathlib.Path(root)/str(i);m.download('https://example.com/file',f,len(payload));assert f.read_bytes()==data
 assert 1<=peak<=2
 payload=b'ABC';bad=True
 try:m.download('https://example.com/file',pathlib.Path(root)/'truncated',len(payload))
 except ValueError:pass
 else:raise AssertionError('Truncated response accepted')
`;
    const r = spawnSync(python, ['-I', '-B', '-c', code], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, (r.stderr ?? '') + String(r.error ?? ''));
});
test('real publisher keyring initializes in an isolated home before download', async () => {
    const { preparePublisher } = await import('../scripts/build-toolchain/verified-java-download.mjs');
    const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'cs-java-publisher-test-'));
    try {
        const result = await preparePublisher(dir);
        assert.equal(path.dirname(result.home), dir);
        assert.equal(path.dirname(result.ring), dir);
        assert.ok(fs.statSync(result.ring).size > 1000);
        assert.ok(fs.statSync(result.home).isDirectory());
    }
    finally {
        assert.equal(path.dirname(fs.realpathSync(dir)), parent);
        assert.match(path.basename(dir), /^cs-java-publisher-test-/);
        assert.ok(!fs.lstatSync(dir).isSymbolicLink());
        fs.rmSync(dir, { recursive: true, force: false });
    }
});

test('all seven Android job pairs retain fresh verified downloads followed by hardening', () => {
    const expected = { 'ci.yml': 1, 'native-audio-lanes.yml': 1,
        'translation-preservation-red.yml': 1, 'translation-selective-wire.yml': 1,
        'unsigned-play-aab.yml': 2, 'unsigned-store-build.yml': 1 };
    for (const [name, count] of Object.entries(expected)) {
        const source = fs.readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
        assert.equal((source.match(/node scripts\/build-toolchain\/verified-java-download\.mjs --install/g) || []).length, count, name);
        assert.equal((source.match(/run: node scripts\/harden-java-truststores\.mjs --ci/g) || []).length, count, name);
        assert.doesNotMatch(source, /actions\/setup-java@/, name);
    }
});
