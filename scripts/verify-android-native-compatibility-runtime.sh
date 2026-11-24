#!/usr/bin/env bash
set -euo pipefail
test "$#" = 2
export JAVA_HOME="${JAVA_HOME_17_X64:?JDK17 required}"
export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p evidence/final-runtime
trap 'printf "{\"status\":\"failed\",\"runtimeEvidenceComplete\":false}\n" > evidence/final-runtime/workflow-status.json' ERR
printf '{"status":"running","runtimeEvidenceComplete":false}\n' > evidence/final-runtime/workflow-status.json
assets="$RUNNER_TEMP/final-assets"
ndk="$ANDROID_HOME/ndk/27.1.12297006"
python3 -B scripts/verify-android-native-compatibility.py --apk "$assets/caption-studio-android.apk" --aab "$assets/caption-studio-play-android.aab" --ndk "$ndk" | tee evidence/final-runtime/solana-native.json
python3 -B scripts/verify-android-native-compatibility.py --apk "$assets/caption-studio-play-universal.apk" --aab "$assets/caption-studio-play-android.aab" --ndk "$ndk" | tee evidence/final-runtime/play-native.json
python3 -B scripts/verify-android-native-compatibility-runtime.py run --directory "$assets" --evidence evidence/final-runtime --api "$1" --arch "$2" --build-tools "$ANDROID_HOME/build-tools/36.0.0"
printf '{"status":"passed","runtimeEvidenceComplete":true}\n' > evidence/final-runtime/workflow-status.json
