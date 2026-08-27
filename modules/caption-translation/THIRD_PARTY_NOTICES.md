# Third-party notices

Caption Translation depends on `com.google.ai.edge.litertlm:litertlm-android:0.16.1`, published from Google AI Edge LiteRT-LM tag `v0.16.1` under the Apache License 2.0.

- Source: https://github.com/google-ai-edge/LiteRT-LM/tree/v0.16.1
- License: https://github.com/google-ai-edge/LiteRT-LM/blob/v0.16.1/LICENSE
- Local license copy: ../../third-party/licenses/Apache-2.0.txt

The pinned LiteRT-LM artifact declares these runtime dependencies:

- Gson 2.13.2 — Apache License 2.0
- Kotlin reflection 2.2.21 — Apache License 2.0
- Kotlin coroutines Android 1.9.0 — Apache License 2.0

Caption Studio does not bundle a translation model in its APK or AAB. When a user enables natural English–Chinese translation, the app downloads the exact Qwen2.5 1.5B Instruct Q8 LiteRT-LM artifact pinned below, verifies its byte size and SHA-256 digest, and then runs it locally.

- Distribution: https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct
- Upstream model: https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct
- Revision: `19edb84c69a0212f29a6ef17ba0d6f278b6a1614`
- File: `Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm`
- Size: `1,597,931,520` bytes
- SHA-256: `faa60663b333290c1496c499828b21d3e3254a788cacd8cce917ce0f761a2dc9`
- License: Apache License 2.0
