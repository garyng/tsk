import { isAbsolute, join, relative } from 'node:path';
import { resolveBridgePath } from './clipboard-bridge-path';

/**
 * Name of the skill installed by `tsk.installClipboardBridgeSkill`. Also
 * the directory under `.claude/skills/` — Claude Code discovers skills by
 * `.claude/skills/<name>/SKILL.md`.
 */
export const CLIPBOARD_BRIDGE_SKILL_NAME = 'tsk-clipboard-bridge';

/**
 * Workspace-relative install path for the skill, e.g.
 * `.claude/skills/tsk-clipboard-bridge/SKILL.md`. Joined with the
 * workspace folder by the install command.
 */
export const CLIPBOARD_BRIDGE_SKILL_REL_PATH = `.claude/skills/${CLIPBOARD_BRIDGE_SKILL_NAME}/SKILL.md`;

/**
 * Build the `SKILL.md` body that teaches Claude to use the clipboard
 * bridge. Pure — the install command supplies `bridgeDisplayPath` (the
 * configured watch-file path, workspace-relative when possible) so the
 * installed skill matches the user's actual `tsk.clipboard.bridgePath`
 * setting rather than hard-coding the default.
 *
 * The skill is the human-readable *contract* the file-watch pattern needs:
 * unlike an MCP tool (which self-describes via a schema), a watched file
 * has no discovery surface, so Claude has to be told the path + the
 * write-the-file protocol. This document is that telling.
 */
/**
 * Resolve the user-entered install path (from the command's input box)
 * into an absolute path. A relative entry is joined onto the workspace
 * folder; an absolute entry is used verbatim. Pure — no I/O.
 */
export function resolveSkillInstallPath(input: string, workspaceFolder: string): string {
    const trimmed = input.trim();
    return isAbsolute(trimmed) ? trimmed : join(workspaceFolder, trimmed);
}

/**
 * Display form of the configured bridge path to bake into the skill:
 * workspace-relative when the resolved path lives under the workspace
 * (the common case — `.vscode/tsk/clipboard-bridge.txt`), absolute
 * otherwise (a power user pointing elsewhere). Falls back to the default
 * relative path when nothing resolves (e.g. blank setting). Pure.
 */
export function bridgeDisplayPath(rawSetting: string, workspaceFolder: string): string {
    const resolved = resolveBridgePath(rawSetting, workspaceFolder);
    if (!resolved) return '.vscode/tsk/clipboard-bridge.txt';
    const rel = relative(workspaceFolder, resolved);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    return resolved;
}

export function buildClipboardBridgeSkillContent(bridgeDisplayPath: string): string {
    return `---
name: ${CLIPBOARD_BRIDGE_SKILL_NAME}
description: Copy text to the user's host clipboard from inside a devcontainer by writing the tsk clipboard-bridge watch file. Use when the user asks you to put something on their clipboard (a command, a snippet, a generated message) and no host clipboard tool (xclip / wl-copy / clip.exe / pbcopy) is reachable.
---

# ${CLIPBOARD_BRIDGE_SKILL_NAME}

Inside this devcontainer no host clipboard tool is reachable — \`xclip\` /
\`wl-copy\` / \`clip.exe\` / \`pbcopy\` aren't installed or can't see the host,
OSC 52 escape sequences don't survive Claude Code's TUI, and the bundled
\`code\` CLI has no clipboard subcommand. But the **tsk extension** runs a
*clipboard bridge*: it watches a file and copies the file's contents to the
host clipboard whenever the file changes.

So to put text on the user's host clipboard, **write it to the watch file**.

## When to use

- The user asks you to copy something to their (host) clipboard.
- You want to hand the user text to paste — a shell command, a snippet, a
  generated commit message — without making them select-and-copy from chat.

## How to use

1. **Check the bridge is live.** The watch file is:

   \`\`\`
   ${bridgeDisplayPath}
   \`\`\`

   The extension *touches* this file when the bridge is enabled, so if it
   exists the bridge is (almost certainly) on. If it does **not** exist, the
   bridge is off — tell the user to set \`tsk.clipboard.bridgeEnabled: true\`
   in their settings, and fall back to printing the text in chat.

2. **Write the exact text to the file** with the \`Write\` tool. Write *only*
   what should be copied — the file's entire contents become the clipboard,
   so no surrounding prose, no code fences, no commentary.

3. **Tell the user** it's on their clipboard, ready to paste. The bridge
   copies within ~300ms (it stat-polls the file).

## Caveats

- **Fire-and-forget.** There's no acknowledgement returned to you. The
  extension logs \`clipboard-bridge: copied N chars\` to its "tsk" Output
  channel — that's the only confirmation, and only the user can see it.
- **It overwrites** both the file and the host clipboard. Never write to it
  unless the user actually asked for that content on their clipboard.
- **Whole-file semantics.** Whatever bytes are in the file get copied. Don't
  append; replace.
- The path above is this workspace's configured \`tsk.clipboard.bridgePath\`.
  If the user changes that setting, re-run **Tsk: Install Clipboard Bridge
  Skill** to regenerate this file with the new path.
`;
}
