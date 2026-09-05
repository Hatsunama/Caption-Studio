# Translation resume repair: 1.4.9

## Root cause

The native worker accumulated batch outputs only in memory and returned them after the entire session. Background cancellation or process death discarded those outputs before the project could commit them. Refresh then repeated completed inference.

## Durable boundary

Complete parsed batch responses are checkpointed by the existing native worker before cancellation is observed. Private no-backup storage survives app/process closure. Each checkpoint is written to a staging file, flushed and synced, then atomically renamed on Android. Incomplete writes and checksum-invalid records are not reused.

The cache identity covers the verified model hash, runtime/sampler/token-limit profile, system instruction, prompt contract, exact language direction, source text, cue IDs, and before/after context. Context or source edits conservatively invalidate matching batches. Quality-repair calls bypass checkpoints so a rejected answer never prevents a new inference attempt. Existing JavaScript quality validation still applies to restored output.

Refresh restores unchanged completed batches. A batch interrupted before a complete response is available must rerun. The model is initialized lazily for the first cache miss; an entirely cached request performs no inference or model initialization. Device/model verification remains enforced. The worker still releases the model on completion/cancellation.

## Resource and quality limits

- No model downgrade, quantization change, context reduction, sampler change, token-limit reduction, or extra inference concurrency.
- Checkpoints are limited to 512 entries / 32 MiB and expire after 30 days.
- Cleanup recognizes only checkpoint-owned filenames in the private checkpoint directory, not projects, source videos, models, signing files, or external storage.
- Checkpoint storage errors are surfaced rather than silently promising recovery.
- Progress polling no longer carries model-verification 100% into the translation stage or manufactures translating progress during model verification.
- First-run translation throughput has not been benchmarked. Cue-preserving translation emits more structured output than the old document-splitting approach; no quality-reducing shortcut was reintroduced.

## Checks

Local: 256 logic tests, TypeScript, and lint passed. Test concurrency was one and the Node heap limit was 768 MiB. No local Android build, paging changes, shared-cache cleanup, signing changes, or additional worker agents were used.

Added native regressions cover cancellation followed by worker recreation, completed-batch reuse, zero model loads for an entirely cached request, repair bypass, checkpoint integrity, incomplete writes, and bounded cleanup that retains unrelated files. These run in Android release CI. A real-phone interruption/resume timing measurement remains a device acceptance check.
