'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const beforeHash = '6dd95802eae01819bc96c64f920eab119c3dbac20a659e3ad8ef602eba47caf8';
const afterHash = '28dc610fbb2db06fc71a57af7a4d85b3c9c741c15153843986d313c034172763';
const relative = 'ReactAndroid/src/main/java/com/facebook/react/views/text/TextLayoutManager.kt';
const hash = value => createHash('sha256').update(value).digest('hex');

const { repairReactNativeSource } = require('./immutable-rn-source.cjs');

function repairFontFitSource(projectRoot) {
  return repairReactNativeSource(projectRoot, {
    relative, beforeHash, afterHash, label: 'fitter',
    prepare(original) {
      const guard = JSON.parse(fs.readFileSync(path.join(__dirname, 'scope-guard.json'), 'utf8'));
      const body = fs.readFileSync(path.join(__dirname, 'adjustSpannableFontToFit.body.kt'));
      const { bodyOffset: start, originalBodyBytes: length } = guard;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
          start + length > original.length || hash(body) !== guard.replacementBodySha256) {
        throw Error('Invalid fitter body payload/guard');
      }
      // Buffer slicing preserves all bytes, including signature, imports and line endings.
      const repaired = Buffer.concat([original.subarray(0, start), body, original.subarray(start + length)]);
      if (hash(repaired) !== afterHash) throw Error('Unexpected repaired fitter hash');
      return repaired;
    },
  });
}

module.exports = { repairFontFitSource };
if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('Usage: node repair-fontfit-source.cjs <project-root>');
    process.exitCode = 1;
  } else {
    try { console.log(repairFontFitSource(process.argv[2]) ? 'Font fitter source repaired' : 'Font fitter source already approved'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
