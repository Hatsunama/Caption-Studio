'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { preflightReactNativeSource, repairReactNativeSource } = require('./immutable-rn-source.cjs');
const sha = b => createHash('sha256').update(b).digest('hex');
const payloadSha256 = '0bfba957c2b9ddb8ba06d7b8a4c3459f9c5a6eaf4b856feb3280443cbc726cb8';
// Closed, ordered scope. No paths or hash overrides from caller or environment.
const allowed = Object.freeze([
  'ReactAndroid/src/main/java/com/facebook/react/views/text/TextLayoutManager.kt',
  'ReactAndroid/src/main/java/com/facebook/react/views/text/PreparedLayout.kt',
  'ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextViewManager.kt',
  'ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextView.java',
  'ReactCommon/react/renderer/attributedstring/conversions.h',
]);
function loadPayload() {
  const bytes = fs.readFileSync(path.join(__dirname, 'source-chunks.json'));
  if (sha(bytes) !== payloadSha256) throw Error('Unapproved composite payload hash');
  const files = JSON.parse(bytes);
  if (!Array.isArray(files) || files.length !== 5) throw Error('Invalid five-file payload scope');
  files.forEach((f, i) => {
    if (f.relative !== allowed[i] || path.isAbsolute(f.relative) || f.relative.includes('\\') ||
        f.relative.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Invalid payload path');
    if (![f.beforeSha256, f.afterSha256].every(h => /^[a-f0-9]{64}$/.test(h)) || !Array.isArray(f.chunks) || !f.chunks.length)
      throw Error('Invalid payload hash/chunks');
    let cursor = 0;
    for (const c of f.chunks) {
      if (!Number.isSafeInteger(c.offset) || !Number.isSafeInteger(c.length) ||
          !Number.isSafeInteger(c.offset + c.length) || c.offset < cursor || c.length < 0 ||
          typeof c.replacementUtf8 !== 'string' || !/^[a-f0-9]{64}$/.test(c.beforeSha256) ||
          sha(Buffer.from(c.replacementUtf8)) !== c.afterSha256) throw Error('Invalid composite chunk payload');
      cursor = c.offset + c.length;
    }
  });
  return files;
}
function prepare(original, f) {
  if (sha(original) !== f.beforeSha256) throw Error('Unknown composite original hash');
  const parts = []; let cursor = 0;
  for (const c of f.chunks) {
    if (c.offset + c.length > original.length || sha(original.subarray(c.offset, c.offset + c.length)) !== c.beforeSha256)
      throw Error('Invalid composite original chunk hash/range');
    parts.push(original.subarray(cursor, c.offset), Buffer.from(c.replacementUtf8));
    cursor = c.offset + c.length;
  }
  parts.push(original.subarray(cursor));
  const result = Buffer.concat(parts);
  if (sha(result) !== f.afterSha256) throw Error('Unexpected composite final hash');
  return result;
}
function installFinalSources(projectRoot) {
  const files = loadPayload();
  // No writes until every path, version, link, full hash AND prepared result is checked.
  const plans = files.map(f => {
    const spec = { relative: f.relative, beforeHash: f.beforeSha256, afterHash: f.afterSha256, label: f.relative };
    const state = preflightReactNativeSource(projectRoot, spec);
    const final = state.digest === f.afterSha256 ? state.original.bytes : prepare(state.original.bytes, f);
    spec.prepare = () => final;
    return { spec, state };
  });
  for (const { state } of plans) state.checkUnchanged();
  let changed = 0;
  for (const { spec, state } of plans) if (repairReactNativeSource(projectRoot, spec, state)) changed++;
  return changed;
}
module.exports = { installFinalSources };
if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: node install-final-sources.cjs <project-root>'); process.exitCode = 1; }
  else {
    try { console.log(JSON.stringify({ changedFiles: installFinalSources(process.argv[2]) })); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
