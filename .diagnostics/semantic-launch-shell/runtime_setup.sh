#!/bin/sh
# Cloud only. Exactly one bounded native runtime setup; no upgrade/dev/JDK.
set +e
timeout -k 5s 300s sh -c 'apt-get update -qq && apt-get install -y --no-install-recommends libvulkan1' > /tmp/semantic-native-setup.stdout 2> /tmp/semantic-native-setup.stderr
rc=$?
printf '%s\n' "$rc" > /tmp/semantic-native-setup.returncode
cat /tmp/semantic-native-setup.stdout
cat /tmp/semantic-native-setup.stderr >&2
exit "$rc"
