#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${ANDROID_HOME:?GitHub runner Android SDK required}"
bt="$ANDROID_HOME/build-tools/36.0.0"
android="$ANDROID_HOME/platforms/android-36/android.jar"
mkdir -p out/classes out/dex
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$android" \
  -d out/classes src/app/captionstudio/verification/sharereceiver/*.java
"$bt/d8" --min-api 24 --lib "$android" --output out/dex \
  $(find out/classes -name '*.class' -print)
"$bt/aapt2" link -I "$android" --manifest AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 36 -o out/unsigned.apk
(cd out/dex && zip -q -0 ../unsigned.apk classes.dex)
"$bt/zipalign" -p -f 4 out/unsigned.apk out/aligned.apk
key="$RUNNER_TEMP/share-recipient-ephemeral.p12"
password="$(openssl rand -hex 24)"
trap 'rm -f "$key"; unset password' EXIT
export VERIFICATION_KEY_PASSWORD="$password"
keytool -genkeypair -keystore "$key" -storetype PKCS12 \
  -storepass:env VERIFICATION_KEY_PASSWORD -keypass:env VERIFICATION_KEY_PASSWORD \
  -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 2 \
  -dname "CN=Android Debug,O=Verification CI,C=US" >/dev/null 2>&1
apk=out/caption-studio-verification-debug.apk
"$bt/apksigner" sign --ks "$key" --ks-key-alias androiddebugkey \
  --ks-pass env:VERIFICATION_KEY_PASSWORD --key-pass env:VERIFICATION_KEY_PASSWORD \
  --out "$apk" out/aligned.apk
unset VERIFICATION_KEY_PASSWORD
"$bt/apksigner" verify --verbose --print-certs "$apk" > out/signature.txt
"$bt/zipalign" -c -v 4 "$apk" > out/alignment.txt
"$bt/aapt2" dump permissions "$apk" > out/permissions.txt
"$bt/aapt2" dump badging "$apk" > out/badging.txt
"$bt/aapt2" dump xmltree --file AndroidManifest.xml "$apk" > out/manifest.txt
python3 audit.py
sha256sum "$apk" | tee out/apk.sha256
{
  echo "HEAD=$GITHUB_SHA"
  echo "APK_NAME=$(basename "$apk")"
  echo "APK_BYTES=$(stat -c %s "$apk")"
  echo "APK_SHA256=$(sha256sum "$apk" | cut -d ' ' -f 1)"
  cat out/tests.txt
  cat out/audit.txt
} | tee out/evidence.txt
cat out/evidence.txt >> "$GITHUB_STEP_SUMMARY"
