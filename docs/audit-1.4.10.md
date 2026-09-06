# Translation repair audit: 1.4.10

## Findings addressed

- Export treated missing/failed/stale translation state as a mandatory block. A shared eligibility calculation now supplies exact missing/review counts and the export warning. Explicit consent allows MP4, SRT and ASS to use available text without changing the saved project.
- Source-script edits automatically started translation. They now offer optional refresh, review, or keeping current text. Opening an existing track is also non-generative.
- Saving primary edits required a populated second-language field. Unchanged empty translations no longer prevent saving the primary language.
- Refresh selection was limited to individual cues or an implicit unfinished/all action. Explicit unfinished/all/selected/individual actions now exist, with a separately persisted, reversible skip flag that does not conflate user choice with clip visibility or trimming.
- Individual refresh lost surrounding context. It now supplies the full visible source context to the selected-cue request.
- Large batches and the JavaScript repair pass compounded failed cues with another engine initialization. Batches are limited to four cues/1000 characters, and bounded single-cue repairs use the same native engine. Existing total cue/character limits and a single worker remain in force; the batch-count ceiling accommodates the smaller batches.
- Source-equality rejection discarded legitimate invariant tokens such as OK, numbers and URLs. Native output validity is now explicit, so a missing response or parser fallback cannot exploit that exception. Unicode script checks also cover Vietnamese extended Latin and supplementary Han characters.
- A source edit could leave a reviewed cue stale while the decoder rejected its retained human-review flag. The decoder now accepts this meaningful state, with round-trip regression coverage.
- One empty pending line suppressed journal writes for every other typed edit. That guard is removed; blank/echo recovery protection remains. Journal-clear and save failures are surfaced rather than producing unhandled rejections or closing through failed cleanup.

## Verification and limits

The local repository-wide JavaScript suite passes 262 tests, including new behavioral tests for export consent inputs, exact counts, skip persistence/timing, preservation of text, stale human-review persistence and short/Unicode translations. Typecheck and lint are release gates. Native tests cover single-engine repair with context, checkpoint restoration without engine reload, and rejection of fabricated OK fallbacks. GitHub's fixed-release workflow must pass JavaScript checks, dependency/Expo checks, native media/translation unit tests, release signing, ZIP/ELF alignment and APK validation before publishing.

The attached authorized device was identified as Seeker, running Caption Studio Fixed 1.4.9 (code 21). A bounded recent-log query found no matching translation crash. That does not rule out earlier errors or prove model quality. Existing projects and phone data were not cleared, changed, exported or uploaded during log inspection.

This is a source-level audit of the affected translation, persistence and export paths plus the repository's full automated regression suite, not a claim of exhaustive on-phone testing of every app feature. On the rebuilt version, test missing-line Export anyway, each refresh selection, a skipped line across reopen/clip movement, editing either language without accepting refresh, interrupt/resume, and playback of an exported dual-language MP4. Human native-speaker evaluation is still needed for accuracy, register and slang across supported languages.

## Performance and model specialization

The current CPU Qwen 2.5 1.5B Q8 model and deterministic sampler are unchanged. Reusing the engine for retries removes initialization overhead; checkpoint hits avoid repeated inference. Four-cue batches can increase prompt-prefill overhead on already-successful scripts, and the colloquial prompt changes output behavior. No measured speedup or equal-quality guarantee is claimed.

Qwen documents [supervised fine-tuning with LoRA](https://qwen.readthedocs.io/en/v3.0/training/llama_factory.html). A specialization project would need licensed multilingual conversational subtitle examples, short-utterance/context examples, separate held-out native-speaker evaluations, and re-conversion/validation for the mobile runtime. Fine-tuning the same-size model does not by itself reduce its parameter count or guarantee faster decoding. Distillation to a smaller model or a different quantization/backend requires fresh quality and memory benchmarks, not an untested release substitution.

[LiteRT-LM supports hardware acceleration](https://developers.google.com/edge/litert-lm/overview), but Seeker/Samsung GPU compatibility, sustained thermal behavior, peak RAM and output quality must be measured before changing the backend. No fine-tuning, model download, local Android build, shared-cache deletion or signing-key deletion was performed on this Windows host for this repair.
