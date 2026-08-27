# Model notices

## Whisper transcription runtime

Caption Studio uses `whisper.rn` 0.7.0, which incorporates `whisper.cpp` and `ggml` native sources. `whisper.rn` is MIT-licensed, Copyright © 2023 Jhen-Jie Hong. `whisper.cpp` and `ggml` are MIT-licensed, Copyright © 2023–2026 The ggml authors. The required license terms and notices are preserved in [MIT-component-notices.txt](third-party/licenses/MIT-component-notices.txt).

- `whisper.rn` source: `https://github.com/mybigday/whisper.rn`
- `whisper.cpp` source: `https://github.com/ggerganov/whisper.cpp`

## Optional multilingual Whisper models

Caption Studio downloads one converted ggml Whisper model only after the user chooses a transcription quality. The Hugging Face distribution identifies these model files as MIT-licensed conversions of OpenAI Whisper models. OpenAI's Whisper repository publishes its code and model weights under the MIT License, Copyright © 2022 OpenAI. All downloads use immutable revision `c521a4b02f422512d734391fdf08bb08c0862f68` and are verified before use.

- Fast, `ggml-tiny-q5_1.bin`: 32,152,673 bytes; SHA-256 `818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7`.
- Balanced, `ggml-base-q5_1.bin`: 59,707,625 bytes; SHA-256 `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`.
- Accurate, `ggml-small-q5_1.bin`: 190,085,487 bytes; SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`.

- Distribution: `https://huggingface.co/ggerganov/whisper.cpp`
- Upstream model: `https://github.com/openai/whisper`
- License: [MIT component notices](third-party/licenses/MIT-component-notices.txt)

## Optional Silero voice-activity model

Caption Studio downloads `ggml-silero-v6.2.0.bin` with the selected Whisper model so silence can be detected before transcription. The ggml distribution declares the converted model MIT-licensed; upstream Silero VAD is MIT-licensed, Copyright © 2020–present Silero Team.

- Distribution: `https://huggingface.co/ggml-org/whisper-vad`
- Upstream: `https://github.com/snakers4/silero-vad`
- Pinned revision: `9ffd54a1e1ee413ddf265af9913beaf518d1639b`
- Exact size: 885,098 bytes
- SHA-256: `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`
- License: [MIT component notices](third-party/licenses/MIT-component-notices.txt)

## MediaPipe Selfie Multiclass Segmentation 256 × 256

Caption Studio bundles `selfie_multiclass_256x256.tflite`, published by Google for the MediaPipe Image Segmenter. It classifies background, hair, body, face, clothing, and other person-associated pixels. The model card identifies the model as Apache License 2.0.

- Source: `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`
- Model card: `https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf`
- SHA-256: `c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0`
- License: [Apache License 2.0](third-party/licenses/Apache-2.0.txt)

The model runs entirely on the Android device. Caption Studio does not send frames to a model server.

## Qwen2.5 1.5B Instruct for optional natural translation

Caption Studio can download `Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm` only when a user enables natural English–Chinese dual subtitles. One model handles English to Simplified Chinese, English to Traditional Chinese, and Chinese to English. It is not bundled in the APK or AAB and runs locally through LiteRT-LM after download.

- Distribution: `https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct`
- Upstream model: `https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct`
- Pinned revision: `19edb84c69a0212f29a6ef17ba0d6f278b6a1614`
- Exact size: `1,597,931,520` bytes
- SHA-256: `faa60663b333290c1496c499828b21d3e3254a788cacd8cce917ce0f761a2dc9`
- License: [Apache License 2.0](third-party/licenses/Apache-2.0.txt)

Machine translation can be inaccurate. Caption Studio preserves the primary script, marks stale translations, supports human editing, and does not describe generated text as guaranteed human translation.
