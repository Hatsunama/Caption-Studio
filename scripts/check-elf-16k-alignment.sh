#!/usr/bin/env bash
set -euo pipefail

apk="${1:-}"
llvm_objdump="${2:-}"
if [[ ! -f "$apk" ]]; then
  echo "APK not found: $apk" >&2
  exit 2
fi
if [[ ! -x "$llvm_objdump" ]]; then
  echo "Android NDK llvm-objdump not found or not executable: $llvm_objdump" >&2
  exit 2
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
unzip -oq "$apk" -d "$temporary_directory"

mapfile -d '' shared_libraries < <(
  find \
    "$temporary_directory/lib/arm64-v8a" \
    "$temporary_directory/lib/x86_64" \
    -type f -name '*.so' -print0 2>/dev/null || true
)
if (( ${#shared_libraries[@]} == 0 )); then
  echo "No 64-bit shared libraries were found in the APK." >&2
  exit 1
fi

failed=0
for shared_library in "${shared_libraries[@]}"; do
  library_failed=0
  mapfile -t load_alignments < <(
    "$llvm_objdump" -p "$shared_library" \
      | awk '$1 == "LOAD" { for (field = 1; field <= NF; field += 1) if ($field == "align") print $(field + 1) }'
  )
  label="${shared_library#"$temporary_directory/"}"
  if (( ${#load_alignments[@]} == 0 )); then
    echo "UNVERIFIED $label: no ELF LOAD segments found" >&2
    failed=1
    library_failed=1
    continue
  fi
  for alignment in "${load_alignments[@]}"; do
    if [[ "$alignment" =~ ^2\*\*([0-9]+)$ ]] && (( BASH_REMATCH[1] >= 14 )); then
      continue
    fi
    echo "UNALIGNED $label: LOAD segment alignment $alignment is below 2**14" >&2
    failed=1
    library_failed=1
  done
  if (( library_failed == 0 )); then
    echo "ALIGNED $label"
  fi
done
exit "$failed"
