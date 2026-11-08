'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { repairReactNativeSource } = require('./immutable-rn-source.cjs');
const beforeHash = 'f6854ff6811b1ead2c93edbe7ae740ac76de78782478bcc2e07f73457a1ab99d';
const afterHash = 'c6621b5224ab4cb980d36dc0c6bca5ae58c84f0bf79e0b3b2a1c2b69439d760a';
const relative = 'ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextView.java';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function repairTextViewSource(projectRoot) {
  return repairReactNativeSource(projectRoot, {
    relative, beforeHash, afterHash, label: 'textview',
    prepare(original) {
      const chunks = JSON.parse(fs.readFileSync(path.join(__dirname, 'textview-chunks.json'), 'utf8'));
      if (!Array.isArray(chunks) || chunks.length !== 10) throw Error('Invalid textview chunks');
      const parts = [];
      let end = 0;
      for (const chunk of chunks) {
        if (!chunk || !Number.isSafeInteger(chunk.offset) || chunk.offset < end ||
            typeof chunk.before !== 'string' || typeof chunk.after !== 'string') {
          throw Error('Invalid textview chunk payload/offset');
        }
        const before = Buffer.from(chunk.before, 'utf8');
        const after = Buffer.from(chunk.after, 'utf8');
        if (chunk.offset + before.length > original.length ||
            hash(before) !== chunk.beforeSha256 || hash(after) !== chunk.afterSha256 ||
            !original.subarray(chunk.offset, chunk.offset + before.length).equals(before)) {
          throw Error('Invalid textview chunk bytes/hash');
        }
        parts.push(original.subarray(end, chunk.offset), after);
        end = chunk.offset + before.length;
      }
      parts.push(original.subarray(end));
      return Buffer.concat(parts);
    },
  });
}

module.exports = { repairTextViewSource };
if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('Usage: node repair-textview-source.cjs <project-root>');
    process.exitCode = 1;
  } else {
    try { console.log(repairTextViewSource(process.argv[2]) ? 'Text view source repaired' : 'Text view source already approved'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
