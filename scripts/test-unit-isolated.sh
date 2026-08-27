#!/usr/bin/env bash
# Run every unit-test file in its own Bun process. The suite intentionally has
# tests that replace process.env, fetch, module-level path caches, and globalThis
# state; process boundaries keep those fixtures from changing later files.
set -euo pipefail

readonly jobs="${OPENSESSION_TEST_JOBS:-1}"
if ! [[ "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENSESSION_TEST_JOBS must be a positive integer (got: $jobs)" >&2
  exit 2
fi

mapfile -d '' tests < <(
  find packages/core/opensession-server/src scripts -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.jsx' \
       -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.js' -o -name '*.spec.jsx' \) \
    -print0 | sort -z
)

if (( ${#tests[@]} == 0 )); then
  echo "No unit-test files found" >&2
  exit 1
fi

printf 'Running %d unit-test files in isolated processes (%d at a time)\n' \
  "${#tests[@]}" "$jobs"
printf '%s\0' "${tests[@]}" | \
  xargs -0 -n 1 -P "$jobs" bun test --no-orphans --reporter dots
