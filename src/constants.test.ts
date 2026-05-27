import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, INTERNAL_COMMANDS } from './constants';

interface ContributedCommand {
    command: string;
    title?: string;
    category?: string;
}

interface PackageManifest {
    contributes?: {
        commands?: ContributedCommand[];
    };
}

const packageJsonPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageManifest;
const contributedIds = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));

describe('COMMANDS registry', () => {
    it('every contributed command in package.json has an entry in COMMANDS', () => {
        // Catches: rename in package.json without rename in code.
        const registryValues = new Set<string>(Object.values(COMMANDS));
        const missingFromRegistry = [...contributedIds].filter((id) => !registryValues.has(id));
        expect(missingFromRegistry).toEqual([]);
    });

    it('every COMMANDS value appears in package.json#contributes.commands', () => {
        // Catches: rename in code without rename in package.json.
        const missingFromManifest = Object.values(COMMANDS).filter((id) => !contributedIds.has(id));
        expect(missingFromManifest).toEqual([]);
    });

    it('COMMANDS and INTERNAL_COMMANDS values do not overlap', () => {
        // The two registries split contributed vs. lens-only commands; a
        // value showing up in both would mean a command is both surfaced
        // in the palette AND lens-only, which is contradictory.
        const commands = new Set<string>(Object.values(COMMANDS));
        const overlap = Object.values(INTERNAL_COMMANDS).filter((id) => commands.has(id));
        expect(overlap).toEqual([]);
    });

    it('INTERNAL_COMMANDS values are absent from package.json', () => {
        // Internal commands require lens-supplied args; if they leak into
        // contributes.commands the Command Palette would offer broken
        // invocations.
        const leaked = Object.values(INTERNAL_COMMANDS).filter((id) => contributedIds.has(id));
        expect(leaked).toEqual([]);
    });
});
