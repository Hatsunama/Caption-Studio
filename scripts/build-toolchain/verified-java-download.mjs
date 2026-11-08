// Transport fallback for the same immutable Temurin releases, not a trust fallback.
// Public verification key is copied from pinned actions/setup-java b843ebf... (MIT).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const PUBLIC_KEY_SHA256 = 'e444aa3242cf75570d768fa7b7e360d6eb67da37ec04cca81c88a532f0055bf9';
export const PUBLIC_KEY_FINGERPRINT = '3B04D753C9050D9A5D343F39843C48A565F8F04B';
export const JAVA_RELEASES = Object.freeze({
    21: Object.freeze({ major: 21, version: '21.0.13+9', file: 'OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz', bytes: 207858352, sha256: 'd7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c', sigBytes: 310, sigSha256: '9033070d11b972570405554d42b2108583c05aae3bd4f4aabeceec69533976b7' }),
    17: Object.freeze({ major: 17, version: '17.0.21+9', file: 'OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz', bytes: 193594705, sha256: '8b9b611d917e3dfd8419d3566b5949226f69b052fed7e109c1368add1dfe8711', sigBytes: 310, sigSha256: '7ec27464f0180ad18ad9733f1151f74367493763187fa48b8fb97ebda203bd0f' }),
});
function requireThat(ok, message) {
    if (!ok)
        throw new Error(message);
}
export function downloadUrl(a, signature = false) { requireThat(Object.values(JAVA_RELEASES).includes(a), 'Unpinned release'); return signature ? `https://github.com/adoptium/temurin${a.major}-binaries/releases/download/jdk-${encodeURIComponent(a.version)}/${a.file}.sig?download=1` : `https://api.adoptium.net/v3/binary/version/jdk-${encodeURIComponent(a.version)}/linux/x64/jdk/hotspot/normal/eclipse`; }
export async function verifyFile(file, bytes, sha256) {
    const stat = fs.lstatSync(file);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === bytes, 'Wrong archive type/size/link count');
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file))
        hash.update(chunk);
    requireThat(hash.digest('hex') === sha256, 'Archive checksum mismatch');
}
export function assertSignatureStatus(output, status) {
    requireThat(status === 0, 'Publisher signature verification failed');
    requireThat(!/\[GNUPG:\] (?:BADSIG|ERRSIG|EXPKEYSIG|EXPSIG|REVKEYSIG|NO_PUBKEY|FAILURE|ERROR|KEYREVOKED|KEYEXPIRED|SIGEXPIRED)\b/.test(output), 'Invalid/expired/revoked publisher signature');
    const valid = [...output.matchAll(/^\[GNUPG:\] VALIDSIG (.+)$/gm)];
    requireThat(valid.length === 1, 'Exactly one publisher signature required');
    const f = valid[0][1].trim().split(/\s+/);
    requireThat(f.length === 10 && f[0] === PUBLIC_KEY_FINGERPRINT && f[9] === PUBLIC_KEY_FINGERPRINT && ['8', '9', '10'].includes(f[7]) && f[8] === '00', 'Wrong publisher/signature digest');
}
const gpgPath = file => {
    if (process.platform !== 'win32')
        return file;
    const converter = path.join(path.dirname(gpgExecutable('gpg')), 'cygpath.exe');
    const converted = command(converter, ['-u', path.resolve(file)]).stdout.trim();
    requireThat(converted.startsWith('/') && [...converted].every(c => c.charCodeAt(0) > 31), 'Invalid native GPG path');
    return converted;
};
function command(exe, args) { const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024, windowsHide: true }); requireThat(!r.error && r.status === 0, `${path.basename(exe)} failed: ${(r.stderr ?? '').slice(-600)}`); return r; }
function gpgExecutable(name) {
    if (process.platform !== 'win32')
        return name;
    const candidate = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', name + '.exe');
    requireThat(fs.statSync(candidate).isFile(), 'Git GPG tool missing');
    return candidate;
}
function download(url, dest, bytes) {
    const python = process.platform === 'win32' ? 'C:\\Python311\\python.exe' : 'python3';
    const script = fileURLToPath(new URL('./ranged-download.py', import.meta.url));
    const r = spawnSync(python, ['-I', '-B', script, url, dest, String(bytes)], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 600000, maxBuffer: 1024 * 1024, windowsHide: true });
    requireThat(!r.error && r.status === 0, 'Bounded HTTPS transport failed; no archive is trusted');
}
export async function preparePublisher(workspace) {
    const key = fileURLToPath(new URL('./adoptium-public.asc', import.meta.url));
    await verifyFile(key, fs.statSync(key).size, PUBLIC_KEY_SHA256);
    const home = path.join(workspace, 'gnupg');
    if (!fs.existsSync(home))
        fs.mkdirSync(home, { mode: 0o700 });
    const ring = path.join(workspace, 'publisher.gpg');
    if (!fs.existsSync(ring))
        command(gpgExecutable('gpg'), ['--no-options', '--batch', '--homedir', gpgPath(home), '--dearmor', '--output', gpgPath(ring), gpgPath(key)]);
    return { home, ring };
}
export async function verifyPublisher(archive, signature, workspace) {
    const { home, ring } = await preparePublisher(workspace);
    const r = spawnSync(gpgExecutable('gpgv'), ['--homedir', gpgPath(home), '--status-fd', '1', '--keyring', gpgPath(ring), gpgPath(signature), gpgPath(archive)], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
    requireThat(!r.error, 'Publisher verifier unavailable');
    assertSignatureStatus(r.stdout ?? '', r.status);
    return { fingerprint: PUBLIC_KEY_FINGERPRINT, status: 'verified' };
}
async function main() {
    const args = process.argv.slice(2);
    requireThat(args.length === 4 && ['--verify-only', '--install'].includes(args[0]) && args[2] === '--receipt', 'Usage: --verify-only|--install <existing stage parent> --receipt <new json path>');
    const install = args[0] === '--install', parent = path.resolve(args[1]), receipt = path.resolve(args[3]);
    requireThat([...parent + receipt].every(c => c.charCodeAt(0) > 31), 'Control character in staging path');
    requireThat(!fs.existsSync(receipt), 'Receipt already exists');
    requireThat(fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink() && path.relative(parent, fs.realpathSync(parent)) === '', 'Stage parent redirected');
    if (install)
        requireThat(process.platform === 'linux' && process.arch === 'x64' && typeof process.env.RUNNER_TOOL_CACHE === 'string' && path.resolve(process.env.RUNNER_TOOL_CACHE) === parent && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'Hatsunama/Caption-Studio' && process.env.GITHUB_ENV && process.env.GITHUB_PATH, 'Installation restricted to isolated authorized Linux CI');
    const work = fs.mkdtempSync(path.join(parent, 'caption-studio-verified-java-'));
    fs.chmodSync(work, 0o700);
    let retain = false;
    const results = [];
    try {
        await preparePublisher(work); // Prove native GPG path/bootstrap before any large download.
        for (const a of [JAVA_RELEASES[21], JAVA_RELEASES[17]]) {
            const archive = path.join(work, a.file), signature = archive + '.sig';
            console.log(`Downloading pinned signed Temurin ${a.version}`);
            download(downloadUrl(a), archive, a.bytes);
            await verifyFile(archive, a.bytes, a.sha256);
            download(downloadUrl(a, true), signature, a.sigBytes);
            await verifyFile(signature, a.sigBytes, a.sigSha256);
            const publisher = await verifyPublisher(archive, signature, work);
            const record = { version: a.version, bytes: a.bytes, sha256: a.sha256, publisher };
            if (install) {
                const folder = path.join(work, 'jdk' + a.major);
                fs.mkdirSync(folder, { mode: 0o700 });
                command('tar', ['--extract', '--gzip', '--no-same-owner', '--no-same-permissions', '--strip-components=1', '--file', archive, '--directory', folder]);
                const release = fs.readFileSync(path.join(folder, 'release'), 'utf8');
                requireThat(release.includes(`JAVA_RUNTIME_VERSION="${a.version}"`) || release.includes(`JAVA_RUNTIME_VERSION="${a.version}-LTS"`), 'Extracted runtime version mismatch');
                requireThat(fs.statSync(path.join(folder, 'bin', 'java')).isFile(), 'No verified Java executable');
                record.home = folder;
            }
            fs.unlinkSync(archive);
            fs.unlinkSync(signature);
            results.push(record);
            console.log(`Verified SHA256 and publisher signature for Temurin ${a.version}`);
        }
        if (install) {
            for (const r of results)
                fs.appendFileSync(process.env.GITHUB_ENV, `JAVA_HOME_${r.version.startsWith('17.') ? 17 : 21}_X64=${r.home}\n`);
            const home = results.find(r => r.version.startsWith('17.')).home;
            fs.appendFileSync(process.env.GITHUB_ENV, `JAVA_HOME=${home}\n`);
            fs.appendFileSync(process.env.GITHUB_PATH, path.join(home, 'bin') + '\n');
            retain = true;
        }
        fs.writeFileSync(receipt, JSON.stringify({ transport: 'official Adoptium API/release signature via bounded HTTPS ranges; fresh download, no JDK cache', install, publicKeySha256: PUBLIC_KEY_SHA256, results }, null, 2) + '\n', { flag: 'wx' });
    }
    finally {
        if (!retain) {
            requireThat(path.dirname(work) === parent && path.basename(work).startsWith('caption-studio-verified-java-') && !fs.lstatSync(work).isSymbolicLink() && path.relative(work, fs.realpathSync(work)) === '', 'Cleanup path redirected');
            fs.rmSync(work, { recursive: true, force: false });
        }
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch(e => { console.error(e.message); process.exitCode = 1; });
