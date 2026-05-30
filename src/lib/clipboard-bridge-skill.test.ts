import { describe, expect, it } from 'vitest';
import {
    bridgeDisplayPath,
    buildClipboardBridgeSkillContent,
    CLIPBOARD_BRIDGE_SKILL_NAME,
    CLIPBOARD_BRIDGE_SKILL_REL_PATH,
} from './clipboard-bridge-skill';

describe('clipboard-bridge skill', () => {
    it('install path is under .claude/skills/<name>/SKILL.md', () => {
        expect(CLIPBOARD_BRIDGE_SKILL_REL_PATH).toBe(
            '.claude/skills/tsk-clipboard-bridge/SKILL.md',
        );
    });

    it('opens with YAML frontmatter carrying the skill name + a description', () => {
        const md = buildClipboardBridgeSkillContent('.vscode/tsk/clipboard-bridge.txt');
        expect(md.startsWith('---\n')).toBe(true);
        expect(md).toContain(`name: ${CLIPBOARD_BRIDGE_SKILL_NAME}`);
        expect(md).toMatch(/\ndescription: .+clipboard/i);
    });

    it('bakes the supplied bridge path into the body verbatim', () => {
        const md = buildClipboardBridgeSkillContent('.vscode/tsk/clipboard-bridge.txt');
        expect(md).toContain('.vscode/tsk/clipboard-bridge.txt');
    });

    it('reflects a custom configured path (not hard-coded to the default)', () => {
        const md = buildClipboardBridgeSkillContent('/abs/custom/clip.txt');
        expect(md).toContain('/abs/custom/clip.txt');
        expect(md).not.toContain('.vscode/tsk/clipboard-bridge.txt');
    });

    it('instructs writing only the payload (whole-file semantics)', () => {
        const md = buildClipboardBridgeSkillContent('x.txt');
        // The skill must warn that the whole file becomes the clipboard.
        expect(md.toLowerCase()).toContain('whole-file');
        expect(md).toContain('Write');
    });

    it('names the enable setting so Claude can guide the user when off', () => {
        const md = buildClipboardBridgeSkillContent('x.txt');
        expect(md).toContain('tsk.clipboard.bridgeEnabled');
    });
});

describe('bridgeDisplayPath', () => {
    it('returns a workspace-relative path when the file is under the workspace', () => {
        expect(
            bridgeDisplayPath('${workspaceFolder}/.vscode/tsk/clipboard-bridge.txt', '/work'),
        ).toBe('.vscode/tsk/clipboard-bridge.txt');
    });

    it('returns the absolute path when the file is outside the workspace', () => {
        expect(bridgeDisplayPath('/tmp/elsewhere/clip.txt', '/work')).toBe(
            '/tmp/elsewhere/clip.txt',
        );
    });

    it('falls back to the default relative path when the setting is blank', () => {
        expect(bridgeDisplayPath('', '/work')).toBe('.vscode/tsk/clipboard-bridge.txt');
    });
});
