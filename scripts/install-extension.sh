#!/usr/bin/env bash
# Install the packaged VSIX into the VS Code this devcontainer is running, so a
# change can be exercised in the real editor without rebuilding the container
# (a rebuild installs the pinned .devcontainer/vsix copy instead).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v code >/dev/null 2>&1; then
    echo "no \`code\` on PATH — run this from a terminal inside the devcontainer." >&2
    exit 1
fi

# By version, not "newest file in artifacts/" — that directory keeps old builds.
version="$(node -p "require('./package.json').version")"
vsix="artifacts/tsk-${version}.vsix"

if [[ ! -f "$vsix" ]]; then
    echo "$vsix not found — run \`task tsk:package\` first." >&2
    exit 1
fi

# --force is load-bearing: the version rarely changes between iterations, and
# without it an install of the same version is a silent no-op.
code --install-extension "$vsix" --force

echo "tsk ${version} installed — run the Developer: Reload Window command to load it."
