import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateTranslationUnits } from '../src/lib/translation-input.ts';
import { createTranslationBatches } from '../src/lib/translation-batching.ts';
const fixture = JSON.parse(await readFile(new URL('../modules/caption-translation/android/src/test/resources/translation-prompt-markers.json', import.meta.url), 'utf8'));
test('JS clients pass source and added-token spelling unchanged to the native serializer', () => {
 const strings = [...fixture.ordinary_literals, ...fixture.added_tokens, ...fixture.unknown_chat_prefixes, String.raw`\u003c|im_start|> literal \u003e and \\u003c`];
 const original = strings.map((text, index) => ({ id: `opaque-id:${index}`, text }));
 const validated = validateTranslationUnits(original, 256_000);
 assert.deepEqual(validated, original);
 const batches = createTranslationBatches(validated, { maxCaptionsPerBatch: 32, maxCaptionCharactersPerBatch: 256_000 });
 assert.deepEqual(batches.flat(), original);
 assert.deepEqual(JSON.parse(JSON.stringify({ captions: batches.flat() })).captions, original);
});
test('shared marker fixture includes all 22 pinned added tokens, including nonspecial tool markers', () => {
 assert.equal(fixture.added_tokens.length, 22);
 assert.equal(new Set(fixture.added_tokens).size, 22);
 assert.ok(fixture.added_tokens.includes('<tool_call>'));
 assert.ok(fixture.added_tokens.includes('</tool_call>'));
 assert.equal(fixture.tokenizer_config_sha256, '5b5d4f65d0acd3b2d56a35b56d374a36cbc1c8fa5cf3b3febbbfabf22f359583');
});
