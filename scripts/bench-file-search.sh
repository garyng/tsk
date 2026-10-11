#!/usr/bin/env bash
# Run the file-search benchmark in a real VS Code and print just the report.
# The workspace is TSK_BENCH_WORKSPACE (set by the `bench:file-search` task);
# point it at a large tree, since that is what's being measured. Separate from
# `test:e2e` on purpose — it is slow and its numbers are the output.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# run-e2e.sh calls `vscode-test`, which only resolves when npm has injected
# node_modules/.bin into PATH. This script is invoked from a task, not an npm
# script, so do it here.
export PATH="$PWD/node_modules/.bin:$PATH"

out="$(mktemp -t tsk-bench-XXXXXX.txt)"
trap 'rm -f "$out"' EXIT

npm run compile:tests >/dev/null
npm run build >/dev/null

TSK_BENCH_OUT="$out" bash scripts/run-e2e.sh --label bench >/dev/null 2>&1 || true

if [[ ! -s "$out" ]]; then
    echo "benchmark produced no report — re-run without output suppression to see why:" >&2
    echo "  PATH=\"\$PWD/node_modules/.bin:\$PATH\" TSK_BENCH_WORKSPACE=<large repo> TSK_BENCH_OUT=/tmp/bench.txt bash scripts/run-e2e.sh --label bench" >&2
    echo "  (from the extension root)" >&2
    exit 1
fi
cat "$out"
