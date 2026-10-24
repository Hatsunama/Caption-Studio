// Build-tool trust only. No product TLS, certificate-chain policy, or host-JDK changes.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, X509Certificate, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const BLOCKED_SHA256 = Object.freeze([
  '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
  'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4',
]);
const blocked = new Set(BLOCKED_SHA256);
const limit = 16 * 1024 * 1024;
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function fileHash(file, io = fs) {
  requireThat(io.statSync(file).size <= limit, 'Input exceeds bounded file size');
  return createHash('sha256').update(io.readFileSync(file)).digest('hex');
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
// Check every existing component, including junctions and dangling symlinks.
// The isolated job must not run concurrent writers against these paths.
export function guardedPath(value, { missing = false, directory = false } = {}, io = fs) {
  requireThat(typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value), 'Missing or invalid path');
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < components.length; i++) {
    cursor = path.join(cursor, components[i]);
    let st;
    try { st = io.lstatSync(cursor); } catch (e) {
      if (e.code === 'ENOENT' && missing && i === components.length - 1) return absolute;
      throw new Error('Required path is missing or inaccessible');
    }
    requireThat(!st.isSymbolicLink(), 'Refusing symbolic link or reparse path');
    if (i < components.length - 1 || directory) requireThat(st.isDirectory(), 'Expected directory');
    else requireThat(st.isFile() && st.nlink === 1, 'Expected regular, unshared file');
  }
  return io.realpathSync(absolute);
}
// Only callers holding an exact, newly created parent/name may invoke this.
// As with guardedPath, the disposable workspace must have no concurrent writers.
export function cleanupOwnedDirectory(parent, name, io = fs) {
  requireThat(typeof name === 'string' && name !== '.' && name !== '..'
    && name.length > 0 && !/[\\/\r\n\0:]/.test(name), 'Invalid owned cleanup name');
  const intendedParent = path.resolve(parent);
  const actualParent = guardedPath(intendedParent, { directory: true }, io);
  requireThat(path.relative(intendedParent, actualParent) === '', 'Cleanup parent redirected');
  const target = path.resolve(intendedParent, name);
  requireThat(inside(actualParent, target) && path.dirname(target) === intendedParent,
    'Cleanup target escapes owned parent');
  const actual = guardedPath(target, { directory: true }, io);
  requireThat(path.relative(target, actual) === '', 'Cleanup target redirected');
  // Node detects symlinks and junctions; inspect every descendant without following them.
  const scan = [target];
  while (scan.length) {
    const directory = scan.pop();
    for (const entry of io.readdirSync(directory)) {
      const child = path.join(directory, entry), st = io.lstatSync(child);
      requireThat(!st.isSymbolicLink(), 'Refusing symbolic link or reparse cleanup path');
      if (st.isDirectory()) scan.push(child);
    }
  }
  if (process.platform === 'win32') {
    // Native FILE_ATTRIBUTE_REPARSE_POINT also catches reparse types that Node
    // does not classify as symlinks. Never recurse through a reparse point.
    const script = "$ErrorActionPreference='Stop'; try { "
      + '$p=$env:JAVA_TRUSTSTORE_CLEANUP_TARGET; $c=$p; while ($c) { '
      + '$i=Get-Item -Force -LiteralPath $c; if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 2 }; '
      + '$c=[IO.Path]::GetDirectoryName($c) }; '
      + '$q=New-Object System.Collections.Generic.Stack[string]; $q.Push($p); while ($q.Count) { '
      + 'foreach ($i in Get-ChildItem -Force -LiteralPath $q.Pop()) { '
      + 'if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 2 }; '
      + 'if ($i.PSIsContainer) { $q.Push($i.FullName) } } }; exit 0 } catch { exit 3 }';
    const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, JAVA_TRUSTSTORE_CLEANUP_TARGET: target },
        stdio: 'ignore', timeout: 30000, windowsHide: true,
      });
    requireThat(!result.error && result.status === 0, 'Native reparse cleanup safety check failed');
  }
  io.rmSync(target, { recursive: true, force: true });
}
function runKeytool(keytool, args) {
  const result = spawnSync(keytool, ['-J-Xmx64m', '-J-Duser.language=en', '-J-Duser.country=US', ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: limit, windowsHide: true,
    // Ambient Java agents/options must not redirect this tool or print secrets.
    env: { ...process.env, JAVA_TOOL_OPTIONS: '', JDK_JAVA_OPTIONS: '', _JAVA_OPTIONS: '' },
  });
  requireThat(!result.error && result.status === 0, 'keytool failed; no fallback truststore is permitted');
  return result.stdout;
}
export function auditStore(keytool, source) {
  const listing = runKeytool(keytool, ['-list', '-rfc', '-keystore', source, '-storepass', 'changeit']);
  const count = listing.match(/Your keystore contains (\d+) entr(?:y|ies)/);
  requireThat(count, 'Unrecognized keytool listing');
  const sections = listing.split(/^Alias name: /m).slice(1);
  requireThat(sections.length === Number(count[1]), 'Incomplete keytool alias listing');
  const seen = new Set();
  const entries = sections.map(section => {
    const alias = section.slice(0, section.indexOf('\n')).replace(/\r$/, '');
    const certs = [...section.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
    requireThat(alias && !seen.has(alias) && /^Entry type: trustedCertEntry\r?$/m.test(section)
      && certs.length === 1, 'Truststore must contain only unambiguous trusted certificate entries');
    seen.add(alias);
    const cert = new X509Certificate(certs[0][0]);
    return { alias, sha256: createHash('sha256').update(cert.raw).digest('hex') };
  });
  return entries.sort((a, b) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0);
}
function equalEntries(actual, expected) {
  requireThat(JSON.stringify(actual) === JSON.stringify(expected), 'Retained alias/certificate audit mismatch');
}
function absent(file, io) {
  try { io.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw new Error('Output already exists; refusing overwrite');
}
export function hardenCopy({ keytool, source, output, io = fs }) {
  source = guardedPath(source, {}, io);
  output = guardedPath(output, { missing: true }, io);
  absent(output, io);
  const originalHash = fileHash(source, io);
  const original = auditStore(keytool, source);
  const retained = original.filter(entry => !blocked.has(entry.sha256));
  const removed = original.filter(entry => blocked.has(entry.sha256));
  requireThat(retained.length > 0, 'Truststore has no retained trust anchor');
  const work = io.mkdtempSync(path.join(path.dirname(output), '.java-truststore-'));
  io.chmodSync(work, 0o700);
  const candidate = path.join(work, 'cacerts');
  let published = false;
  try {
    io.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL);
    io.chmodSync(candidate, 0o600);
    requireThat(fileHash(candidate, io) === originalHash && fileHash(source, io) === originalHash,
      'Source changed during protected copy');
    for (const { alias } of removed) runKeytool(keytool, ['-delete', '-keystore', candidate,
      '-storepass', 'changeit', '-alias', alias]);
    equalEntries(auditStore(keytool, candidate), retained);
    requireThat(fileHash(source, io) === originalHash, 'Source preservation check failed');
    guardedPath(output, { missing: true }, io);
    // Exclusive hard-link publication cannot silently overwrite a concurrent output.
    io.linkSync(candidate, output);
    published = true;
  } finally {
    try { cleanupOwnedDirectory(path.dirname(output), path.basename(work), io); } catch {
      // Never remove the only complete output when cleanup fails.
      throw new Error('Owned temporary copy cleanup failed; complete output may remain');
    }
  }
  requireThat(published, 'Copy was not published');
  return { source, output, originalHash, removed: removed.length, retained: retained.length,
    removedFingerprints: [...new Set(removed.map(entry => entry.sha256))].sort() };
}

// Exported for disposable-store failure tests. The CLI calls this only after runCi's gates.
// Verified backups survive errors, including rollback or cleanup errors.
export function commitStores(stores, backupDir, io = fs) {
  guardedPath(backupDir, { directory: true }, io);
  const records = [];
  const touched = [];
  const owned = [];
  try {
    for (const store of stores) {
      guardedPath(store.source, {}, io);
      requireThat(fileHash(store.source, io) === store.originalHash, 'Source changed before backup');
      const backup = path.join(backupDir, `original-${randomUUID()}`);
      io.copyFileSync(store.source, backup, fs.constants.COPYFILE_EXCL);
      io.chmodSync(backup, 0o600);
      requireThat(fileHash(backup, io) === store.originalHash, 'Backup integrity check failed');
      records.push({ ...store, backup, mode: io.statSync(store.source).mode & 0o777 });
    }
    // Verify every original and every backup before replacing any original.
    for (const record of records) requireThat(fileHash(record.source, io) === record.originalHash
      && fileHash(record.backup, io) === record.originalHash, 'Source preservation check failed');
    for (const record of records) {
      guardedPath(record.source, {}, io);
      requireThat(fileHash(record.source, io) === record.originalHash, 'Source changed before replacement');
      const work = io.mkdtempSync(path.join(path.dirname(record.source), '.java-truststore-replace-'));
      owned.push({ parent: path.dirname(record.source), name: path.basename(work) }); io.chmodSync(work, 0o700);
      const replacement = path.join(work, 'replacement');
      io.copyFileSync(record.staged, replacement, fs.constants.COPYFILE_EXCL);
      io.chmodSync(replacement, record.mode);
      requireThat(fileHash(replacement, io) === fileHash(record.staged, io), 'Replacement integrity check failed');
      io.renameSync(replacement, record.source);
      touched.push(record);
      requireThat(fileHash(record.source, io) === fileHash(record.staged, io), 'Installed file audit failed');
      if (record.keytool) equalEntries(auditStore(record.keytool, record.source), auditStore(record.keytool, record.staged));
    }
    return records.map(({ source, backup }) => ({ source, backup }));
  } catch (error) {
    let failed = false;
    for (const record of touched.reverse()) {
      try {
        guardedPath(record.source, {}, io);
        requireThat(fileHash(record.backup, io) === record.originalHash, 'Backup changed');
        // Backup remains available even if restoration is interrupted.
        io.copyFileSync(record.backup, record.source);
        io.chmodSync(record.source, record.mode);
        requireThat(fileHash(record.source, io) === record.originalHash, 'Rollback audit failed');
      } catch { failed = true; }
    }
    if (failed) throw new Error(`Rollback failed; verified backups retained under ${backupDir}`);
    throw error;
  } finally {
    for (const { parent, name } of owned) {
      try { cleanupOwnedDirectory(parent, name, io); } catch {
        throw new Error(`Replacement cleanup failed; backups retained under ${backupDir}`);
      }
    }
  }
}

function escapeProperty(value) {
  return value.replace(/[^\x21-\x7e]|[\\:=#!]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function checkGradleProperties(existing) {
  // Parse Java properties without rewriting any original bytes. Continuations,
  // escaped delimiters and Unicode escapes must not conceal a security setting.
  const decode = value => value.replace(/\\u([0-9a-fA-F]{4})|\\([^u])/g,
    (_, hex, char) => hex ? String.fromCharCode(parseInt(hex, 16))
      : ({ t: '\t', r: '\r', n: '\n', f: '\f' }[char] ?? char));
  let logical = '';
  for (let line of existing.replace(/^\ufeff/, '').split(/\r\n|\n|\r/)) {
    line = line.replace(/^[ \t\f]+/, '');
    if (!logical && (!line || /^[#!]/.test(line))) continue;
    logical += line;
    if ((logical.match(/\\+$/)?.[0].length || 0) % 2) {
      logical = logical.slice(0, -1); continue;
    }
    requireThat(!/\\u(?![0-9a-fA-F]{4})/.test(logical), 'Invalid Gradle property security encoding');
    let boundary = logical.length;
    for (let i = 0; i < logical.length; i++) {
      if (logical[i] === '\\') { i++; continue; }
      if (/[=:\t\f ]/.test(logical[i])) { boundary = i; break; }
    }
    const key = decode(logical.slice(0, boundary));
    const value = decode(logical.slice(boundary).replace(/^[ \t\f]*[=:]?[ \t\f]*/, ''));
    requireThat(!/^(?:systemProp\.)?(?:javax\.net\.ssl\.|java\.security\.|jdk\.security\.|java\.home$|user\.home$|gradle\.user\.home$)/.test(key)
      && !/^systemProp\.org\.gradle\./.test(key), 'Unverified Gradle security or runtime override');
    if (key === 'org.gradle.jvmargs') {
      requireThat(value.trim().split(/\s+/).filter(Boolean).every(option =>
        /^-Xm[sx]\d+[kKmMgG]?$/.test(option)
        || /^-XX:MaxMetaspaceSize=\d+[kKmMgG]?$/.test(option)
        || option === '-XX:+HeapDumpOnOutOfMemoryError' || option === '-Dfile.encoding=UTF-8'),
      'Unverified Gradle JVM launcher options');
    }
    logical = '';
  }
  requireThat(!logical, 'Incomplete Gradle property security continuation');
}
export function gradleProperties(existing, activeHome) {
  checkGradleProperties(existing);
  const block = '\n\n# Hardened build-tool JDK selection (managed)\n'
    + 'org.gradle.java.installations.fromEnv=JAVA_HOME_17_X64,JAVA_HOME_21_X64\n'
    + 'org.gradle.java.installations.paths=\n'
    + 'org.gradle.java.installations.auto-detect=false\n'
    + 'org.gradle.java.installations.auto-download=false\n'
    + (activeHome ? `org.gradle.java.home=${escapeProperty(activeHome)}\n` : '');
  return existing.endsWith(block) ? existing : existing + block;
}
function runtime(home, expectedMajor) {
  home = guardedPath(home, { directory: true });
  const source = guardedPath(path.join(home, 'lib/security/cacerts'));
  requireThat(inside(home, source), 'Truststore escapes runtime');
  const keytool = guardedPath(path.join(home, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'));
  const release = guardedPath(path.join(home, 'release'));
  requireThat(fs.statSync(release).size < 65536, 'Invalid runtime release file');
  const version = fs.readFileSync(release, 'utf8').match(/^JAVA_VERSION="(\d+)(?:[.\-+][^"\r\n]*)?"\r?$/m);
  requireThat(version && (!expectedMajor || Number(version[1]) === expectedMajor), 'Wrong or missing runtime version');
  // JSSE prefers jssecacerts over cacerts. An alternate store would bypass this audit.
  absent(path.join(home, 'lib/security/jssecacerts'), fs);
  return { home, source, keytool };
}
export function runCi(env = process.env) {
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'Hatsunama/Caption-Studio',
    'In-place mode is restricted to the authorized isolated GitHub Actions repository');
  const ambient = { ...process.env, ...env };
  const forbidden = new Set(['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'GRADLE_OPTS',
    'JAVA_OPTS', 'GRADLE_HOME', 'GRADLE_JAVA_HOME', 'JAVACMD', 'JAVA_CMD', 'JDK_HOME', 'JAVA_HOME_OVERRIDE']);
  for (const [name, value] of Object.entries(ambient)) {
    requireThat(!value || (!forbidden.has(name.toUpperCase())
      && !/^ORG_GRADLE_PROJECT_/i.test(name)), 'Unverified ambient Java/Gradle launcher or runtime override');
  }
  const cache = guardedPath(env.RUNNER_TOOL_CACHE, { directory: true });
  const temp = guardedPath(env.RUNNER_TEMP, { directory: true });
  const homes = [17, 21].map(major => {
    const home = guardedPath(env[`JAVA_HOME_${major}_X64`], { directory: true });
    requireThat(inside(cache, home), 'JDK home must be strictly within RUNNER_TOOL_CACHE');
    return { major, ...runtime(home, major) };
  });
  requireThat(homes[0].home !== homes[1].home, 'JDK17 and JDK21 must be distinct runtimes');
  const active = guardedPath(env.JAVA_HOME, { directory: true });
  requireThat(homes.some(jdk => jdk.home === active), 'Active JAVA_HOME must be one of the audited JDKs');
  const home = guardedPath(env.HOME, { directory: true });
  const gradleHome = path.join(home, '.gradle');
  guardedPath(gradleHome, { missing: true, directory: true });
  requireThat(!env.GRADLE_USER_HOME || path.resolve(env.GRADLE_USER_HOME) === gradleHome,
    'GRADLE_USER_HOME must use the private HOME/.gradle directory');
  // Reject properties before creating staging directories or changing either store.
  const properties = fs.existsSync(gradleHome)
    ? guardedPath(path.join(gradleHome, 'gradle.properties'), { missing: true })
    : path.join(gradleHome, 'gradle.properties');
  const existed = fs.existsSync(properties);
  const original = existed ? fs.readFileSync(properties) : Buffer.alloc(0);
  requireThat(original.length <= limit, 'Gradle properties exceed bounded size');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original);
  const updated = gradleProperties(text, active);
  const work = fs.mkdtempSync(path.join(temp, 'java-truststore-hardening-'));
  fs.chmodSync(work, 0o700);
  // Keep this private directory: it contains verified recovery backups, never logged contents.
  const results = [];
  const staged = [];
  try {
    for (const jdk of homes) {
      const output = path.join(work, `jdk-${jdk.major}-hardened`);
      const result = hardenCopy({ ...jdk, output });
      results.push({ major: jdk.major, home: jdk.home, source: jdk.source,
        removed: result.removed, retained: result.retained, removedFingerprints: result.removedFingerprints });
      staged.push({ source: jdk.source, staged: output, originalHash: result.originalHash, keytool: jdk.keytool });
    }
    if (!fs.existsSync(gradleHome)) fs.mkdirSync(gradleHome, { mode: 0o700 });
    guardedPath(gradleHome, { directory: true });
    if (process.getuid) requireThat(fs.statSync(gradleHome).uid === process.getuid(), 'Gradle directory is not owned by this job');
    fs.chmodSync(gradleHome, 0o700);
    const propsStage = path.join(work, 'gradle.properties');
    fs.writeFileSync(propsStage, updated, { flag: 'wx', mode: 0o600 });
    if (existed) staged.push({ source: properties, staged: propsStage, originalHash: fileHash(properties) });
    // If a new properties file is needed, publish it before modifying either JDK.
    // On failure it is removed; an existing file is in the same backup transaction.
    let created = false;
    let backups;
    try {
      if (!existed) { fs.linkSync(propsStage, properties); fs.unlinkSync(propsStage); created = true; }
      backups = commitStores(staged, work);
    } catch (error) {
      if (created) fs.unlinkSync(properties);
      throw error;
    }
    fs.chmodSync(properties, 0o600);
    return { ok: true, mode: 'ci', activeJavaHome: active, blockedFingerprints: BLOCKED_SHA256,
      runtimes: results, gradleProperties: properties, backupDirectory: work, backups };
  } finally {
    // Only remove our staging files. Recovery backups always survive.
    for (const file of ['jdk-17-hardened', 'jdk-21-hardened', 'gradle.properties']) {
      try { fs.unlinkSync(path.join(work, file)); } catch (e) { if (e.code !== 'ENOENT') throw new Error('CI staging cleanup failed'); }
    }
  }
}
export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--ci') return runCi();
  requireThat(args.length === 5 && args[0] === '--prepare',
    'Usage: --ci OR --prepare --java-home <JDK_HOME> --output <NEW_FILE>');
  const options = new Map();
  for (let i = 1; i < args.length; i += 2) {
    requireThat(['--java-home', '--output'].includes(args[i]) && !options.has(args[i]), 'Invalid or duplicate option');
    options.set(args[i], args[i + 1]);
  }
  requireThat(options.size === 2, 'Both --java-home and --output are required');
  const jdk = runtime(options.get('--java-home'));
  const result = hardenCopy({ ...jdk, output: options.get('--output') });
  // File hashes/aliases are internal checks. Output contains public certificate fingerprints only.
  return { ok: true, mode: 'prepare', source: result.source, output: result.output,
    removed: result.removed, retained: result.retained, removedFingerprints: result.removedFingerprints,
    blockedFingerprints: BLOCKED_SHA256 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
