# Caption Studio third-party notices

Caption Studio distributes or loads the following principal third-party runtimes and models. Exact JavaScript package versions are locked in `package-lock.json`; downloaded model revisions, sizes, and hashes are recorded in [MODEL_NOTICES.md](MODEL_NOTICES.md).

## MIT components

- `whisper.rn` 0.7.0, including its React Native bindings: MIT, Copyright © 2023 Jhen-Jie Hong.
- Vendored `whisper.cpp` and `ggml` native sources used by `whisper.rn`: MIT, Copyright © 2023–2026 The ggml authors.
- OpenAI Whisper code and model weights represented by the optional converted ggml model downloads: MIT, Copyright © 2022 OpenAI.
- Silero VAD code and model represented by the optional converted ggml VAD download: MIT, Copyright © 2020–present Silero Team.
- Expo SDK and Expo modules: MIT, Copyright © 2015–present 650 Industries, Inc. (aka Expo).
- React Native and related Meta runtime components: MIT, Copyright © Meta Platforms, Inc. and affiliates.
- React Navigation: MIT, Copyright © 2017 React Navigation Contributors.

The required copyright and permission notices are preserved in [MIT-component-notices.txt](third-party/licenses/MIT-component-notices.txt).

## Apache License 2.0 components

- Google MediaPipe Tasks Vision and the bundled MediaPipe Selfie Multiclass Segmentation model.
- Google AI Edge LiteRT-LM.
- AndroidX Media3 Transformer and Effect.
- Gson, Kotlin reflection, and Kotlin coroutines.
- Fontdiner Swanky and Permanent Marker fonts.
- Qwen2.5 1.5B Instruct and the optional LiteRT-LM conversion used for natural English–Chinese translation.

The Apache License 2.0 text is preserved in [Apache-2.0.txt](third-party/licenses/Apache-2.0.txt). Component-specific model provenance is in [MODEL_NOTICES.md](MODEL_NOTICES.md).

## Google ML Kit

Google ML Kit Face Detection is a Google SDK governed by the [Google APIs Terms of Service](https://developers.google.com/terms) and [ML Kit terms and data-disclosure documentation](https://developers.google.com/ml-kit/terms). It is not represented as an open-source Apache component in Caption Studio's notices.

## Fonts

Bundled font license and copyright files are preserved individually under [`assets/fonts/licenses`](assets/fonts/licenses). Imported fonts are supplied by the user, who remains responsible for permission to use them.
