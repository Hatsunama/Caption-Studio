#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out/test
javac -encoding UTF-8 --release 8 -d out/test \
  src/app/captionstudio/verification/sharereceiver/Validator.java \
  src/app/captionstudio/verification/sharereceiver/BoundedRead.java \
  tests/ValidatorTest.java
java -cp out/test app.captionstudio.verification.sharereceiver.ValidatorTest \
  fixtures/source-expected.srt | tee out/tests.txt
