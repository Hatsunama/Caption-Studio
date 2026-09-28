import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const webSource = readFileSync(new URL('../modules/caption-translation/src/CaptionTranslationModule.web.ts', import.meta.url), 'utf8');
const nativeSource = readFileSync(new URL('../modules/caption-translation/android/src/main/java/app/captionstudio/translation/NaturalCaptionTranslator.java', import.meta.url), 'utf8');

test('web translation limits match the Android transport capacity contract', () => {
  const js = ts.transpileModule(webSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    require: () => ({ NativeModule: class {}, registerWebModule: (value) => new value() }),
  });
  const limits = module.exports.default.limits;
  const nativeValues = Object.fromEntries([...nativeSource.matchAll(/static final int (MAX_[A-Z_]+) = ([\d_]+);/g)]
    .map(([, name, value]) => [name, Number(value.replaceAll('_', ''))]));
  assert.equal(limits.maxCharactersPerCaption, nativeValues.MAX_CAPTION_CHARACTERS);
  assert.equal(limits.maxCaptionCharactersPerBatch, nativeValues.MAX_TOTAL_CAPTION_CHARACTERS);
  assert.equal(limits.maxCaptionCharactersPerSession, nativeValues.MAX_SESSION_CAPTION_CHARACTERS);
  assert.equal(limits.maxCaptionsPerBatch, nativeValues.MAX_CAPTIONS);
  assert.equal(limits.maxOperationsPerSession, nativeValues.MAX_OPERATIONS);
  assert.equal(limits.maxBatchesPerSession, nativeValues.MAX_BATCHES);
  assert.equal(limits.maxCaptionsPerSession, nativeValues.MAX_SESSION_CAPTIONS);
});
