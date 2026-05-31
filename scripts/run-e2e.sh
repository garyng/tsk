#!/usr/bin/env bash
# Run the @vscode/test-cli e2e suite. Wraps the runner in Xvfb when available
# (devcontainer/CI), otherwise relies on a host display (macOS, WSL2 host, etc.).
set -euo pipefail

if command -v xvfb-run >/dev/null 2>&1; then
    exec xvfb-run -a --server-args="-screen 0 1280x720x24" vscode-test "$@"
else
    exec vscode-test "$@"
fi
