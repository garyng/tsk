#!/usr/bin/env bash
# Install the packaged VSIX into the VS Code this machine (or container) is
# running, so a change can be exercised in the real editor straight away.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The pid listening on a Unix socket: empty when nothing does, or where `ss`
# (Linux's iproute2) can't say.
listener() {
    ss -xlpH "src = $1" 2>/dev/null | grep -om1 'pid=[0-9]*' | cut -d= -f2 || true
}

# Where `ss` can't say, a socket file is taken as live.
live() {
    [[ -S "$1" ]] || return 1
    command -v ss >/dev/null 2>&1 || return 0
    [[ -n "$(listener "$1")" ]]
}

# `code` talks to the server over the socket named by VSCODE_IPC_HOOK_CLI. A
# shell that outlived the window it was spawned from (a detached/agent shell, a
# reconnected session) still carries the OLD socket path, and `code` then fails
# with a bare ENOENT node stack; a shell VS Code didn't start has none. Fall
# back to the newest live socket, looked for where VS Code makes them: an
# --install-extension lands in the shared server, not in a particular window,
# so which window answers does not matter — so long as one does (below).
if ! live "${VSCODE_IPC_HOOK_CLI:-}"; then
    VSCODE_IPC_HOOK_CLI=""
    for sock in $(ls -t "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"/vscode-ipc-*.sock 2>/dev/null || true); do
        if live "$sock"; then
            VSCODE_IPC_HOOK_CLI="$sock"
            break
        fi
    done
    if [[ -z "$VSCODE_IPC_HOOK_CLI" ]]; then
        echo "no live VS Code IPC socket — is a window open on this container?" >&2
        exit 1
    fi
    export VSCODE_IPC_HOOK_CLI
fi

# The remote CLI sits beside the node of the server listening on that socket,
# the same version as it. A VS Code terminal has it on PATH too, but another
# shell may find only the devcontainer base image's /usr/local/bin/code: a shim
# that looks further down PATH for a real `code` and fails "code or
# code-insiders is not installed". A desktop VS Code has no remote CLI; its
# `code` is the one on PATH.
cli=""
server="$(listener "$VSCODE_IPC_HOOK_CLI")"
if [[ -n "$server" ]]; then
    cli="$(dirname "$(readlink -f "/proc/$server/exe")")/bin/remote-cli/code"
fi
if [[ ! -x "$cli" ]] && ! cli="$(command -v code)"; then
    echo "no \`code\` on PATH — run this from a VS Code integrated terminal." >&2
    exit 1
fi

# By version, not "newest file in artifacts/" — that directory keeps old builds.
version="$(node -p "require('./package.json').version")"
vsix="artifacts/tsk-${version}.vsix"

if [[ ! -f "$vsix" ]]; then
    echo "$vsix not found — run \`task package\` first." >&2
    exit 1
fi

# The remote CLI hands the install to a window to run, and a window that is
# disconnected (the laptop asleep, the session reached some other way) never
# answers. timeout signals the CLI's whole process group, its node included.
# --force is load-bearing: the version rarely changes between iterations, and
# without it an install of the same version is a silent no-op.
wait_for="${TSK_INSTALL_TIMEOUT:-60}"
status=0
timeout "$wait_for" "$cli" --install-extension "$vsix" --force || status=$?
if ((status == 124)); then
    echo "VS Code didn't answer within ${wait_for} s on $VSCODE_IPC_HOOK_CLI — is that window connected? Run this from a terminal in a window that is." >&2
fi
if ((status != 0)); then
    exit "$status"
fi

echo "tsk ${version} installed — run the Developer: Reload Window command to load it."
