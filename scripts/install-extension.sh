#!/usr/bin/env bash
# Install the packaged VSIX into the VS Code this machine (or container) is
# running, so a change can be exercised in the real editor straight away.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v code >/dev/null 2>&1; then
    echo "no \`code\` on PATH — run this from a VS Code integrated terminal." >&2
    exit 1
fi

# `code` talks to the server over the socket named by VSCODE_IPC_HOOK_CLI. A
# shell that outlived the window it was spawned from (a detached/agent shell, a
# reconnected session) still carries the OLD socket path, and `code` then fails
# with a bare ENOENT node stack. Fall back to the newest live socket: an
# --install-extension lands in the shared server, not in a particular window,
# so which window answers does not matter.
if [[ ! -S "${VSCODE_IPC_HOOK_CLI:-}" ]]; then
    newest="$(ls -t /tmp/vscode-ipc-*.sock 2>/dev/null | head -1 || true)"
    if [[ ! -S "$newest" ]]; then
        echo "no live VS Code IPC socket — is a window open on this container?" >&2
        exit 1
    fi
    export VSCODE_IPC_HOOK_CLI="$newest"
fi

# By version, not "newest file in artifacts/" — that directory keeps old builds.
version="$(node -p "require('./package.json').version")"
vsix="artifacts/tsk-${version}.vsix"

if [[ ! -f "$vsix" ]]; then
    echo "$vsix not found — run \`task package\` first." >&2
    exit 1
fi

# --force is load-bearing: the version rarely changes between iterations, and
# without it an install of the same version is a silent no-op.
code --install-extension "$vsix" --force

echo "tsk ${version} installed — run the Developer: Reload Window command to load it."
