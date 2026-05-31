import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as oniguruma from 'vscode-oniguruma';
import { type IGrammar, INITIAL, parseRawGrammar, Registry } from 'vscode-textmate';

const grammarPath = path.resolve(__dirname, '../../syntaxes/tsk.tmLanguage.json');

let grammar: IGrammar;

beforeAll(async () => {
    const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
    const wasmBin = await fs.readFile(wasmPath);
    await oniguruma.loadWASM(wasmBin);

    const grammarContent = await fs.readFile(grammarPath, 'utf-8');

    const registry = new Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
            createOnigString: (s) => new oniguruma.OnigString(s),
        }),
        loadGrammar: async (scopeName) => {
            if (scopeName === 'text.html.markdown.tsk') {
                return parseRawGrammar(grammarContent, grammarPath);
            }
            if (scopeName === 'text.html.markdown') {
                return parseRawGrammar(
                    JSON.stringify({
                        name: 'Markdown',
                        scopeName: 'text.html.markdown',
                        patterns: [],
                    }),
                    'markdown-stub.json',
                );
            }
            return null;
        },
    });

    const loaded = await registry.loadGrammar('text.html.markdown.tsk');
    if (!loaded) {
        throw new Error('failed to load tsk grammar');
    }
    grammar = loaded;
});

function scopesAt(line: string, col: number): string[] {
    const tokens = grammar.tokenizeLine(line, INITIAL).tokens;
    const token = tokens.find((t) => t.startIndex <= col && col < t.endIndex);
    return token?.scopes ?? [];
}

function scopesContaining(line: string, scope: string): string[][] {
    const tokens = grammar.tokenizeLine(line, INITIAL).tokens;
    return tokens.filter((t) => t.scopes.includes(scope)).map((t) => t.scopes);
}

describe('tsk grammar — task markers', () => {
    const cases: Array<[string, string, number]> = [
        ['todo', '- [ ] do thing', 3],
        ['in-progress', '- [/] do thing', 3],
        ['completed (lower)', '- [x] do thing', 3],
        ['completed (upper)', '- [X] do thing', 3],
        ['moved', '- [>] do thing', 3],
        ['cancelled', '- [!] do thing', 3],
        ['notes (lower)', '- [n] note', 3],
        ['notes (upper)', '- [N] note', 3],
    ];

    const markerToScope: Record<string, string> = {
        todo: 'markup.task-marker.todo.tsk',
        'in-progress': 'markup.task-marker.inprogress.tsk',
        'completed (lower)': 'markup.task-marker.completed.tsk',
        'completed (upper)': 'markup.task-marker.completed.tsk',
        moved: 'markup.task-marker.moved.tsk',
        cancelled: 'markup.task-marker.cancelled.tsk',
        'notes (lower)': 'markup.task-marker.notes.tsk',
        'notes (upper)': 'markup.task-marker.notes.tsk',
    };

    for (const [name, line, col] of cases) {
        it(`scopes the marker char for ${name}`, () => {
            const scopes = scopesAt(line, col);
            expect(scopes).toContain(markerToScope[name]);
        });
    }

    it('scopes the brackets around the marker', () => {
        const line = '- [x] done';
        expect(scopesAt(line, 2)).toContain('punctuation.definition.task-marker.begin.tsk');
        expect(scopesAt(line, 4)).toContain('punctuation.definition.task-marker.end.tsk');
    });

    it('scopes the bullet dash', () => {
        expect(scopesAt('- [x] done', 0)).toContain('punctuation.definition.list.begin.tsk');
    });

    it('matches indented task markers', () => {
        expect(scopesAt('    - [x] done', 7)).toContain('markup.task-marker.completed.tsk');
    });

    it('matches alternative bullet chars (* and +)', () => {
        expect(scopesAt('* [x] done', 3)).toContain('markup.task-marker.completed.tsk');
        expect(scopesAt('+ [x] done', 3)).toContain('markup.task-marker.completed.tsk');
    });

    it('does not match malformed markers', () => {
        expect(scopesAt('- [xx] not a task', 3)).not.toContain('markup.task-marker.completed.tsk');
        expect(scopesAt('-[x] missing space', 2)).not.toContain('markup.task-marker.completed.tsk');
    });
});

describe('tsk grammar — inline metadata', () => {
    it('wraps the whole comment as a metadata block', () => {
        const line = 'before <!-- @id:abc12345 --> after';
        const open = scopesAt(line, 7);
        const close = scopesAt(line, 25);
        expect(open).toContain('comment.block.metadata.tsk');
        expect(close).toContain('comment.block.metadata.tsk');
    });

    it('scopes @ + key + : + value separately', () => {
        const line = '<!-- @id:abc12345 -->';
        expect(scopesAt(line, 5)).toContain('punctuation.definition.metadata.tsk');
        expect(scopesAt(line, 6)).toContain('entity.name.tag.metadata.tsk');
        expect(scopesAt(line, 8)).toContain('punctuation.separator.key-value.metadata.tsk');
        expect(scopesAt(line, 9)).toContain('string.unquoted.metadata.tsk');
    });

    it('handles multiple metadata entries in one comment', () => {
        const line = '<!-- @id:abc12345 @created:2026-01-02T12:45 -->';
        const keyScopes = scopesContaining(line, 'entity.name.tag.metadata.tsk');
        expect(keyScopes.length).toBe(2);
        const valueScopes = scopesContaining(line, 'string.unquoted.metadata.tsk');
        expect(valueScopes.length).toBe(2);
    });

    it('handles a value-less metadata entry', () => {
        const line = '<!-- @completed -->';
        expect(scopesAt(line, 6)).toContain('entity.name.tag.metadata.tsk');
    });

    it('does not let the value swallow the closing -->', () => {
        // No space before the closing tag — value must stop at `-->`, else
        // the comment block never closes and bleeds into following text.
        const line = '<!-- @id:abc12345--> trailing';
        // The value scope must apply to `abc12345` (positions 9..16).
        expect(scopesAt(line, 9)).toContain('string.unquoted.metadata.tsk');
        expect(scopesAt(line, 16)).toContain('string.unquoted.metadata.tsk');
        // The text after `-->` must be outside the comment.
        expect(scopesAt(line, 21)).not.toContain('comment.block.metadata.tsk');
    });
});

describe('tsk grammar — tags', () => {
    it('scopes a simple tag at line start', () => {
        const line = '#JIRAID-123 some content';
        expect(scopesAt(line, 0)).toContain('punctuation.definition.tag.tsk');
        expect(scopesAt(line, 1)).toContain('entity.name.tag.tsk');
    });

    it('scopes a hierarchical tag with slashes', () => {
        const line = 'see #inventory/homelab/nas1 for details';
        expect(scopesAt(line, 4)).toContain('punctuation.definition.tag.tsk');
        expect(scopesAt(line, 5)).toContain('entity.name.tag.tsk');
    });

    it('does not scope `# heading` (markdown heading) as a tag', () => {
        const line = '# heading';
        expect(scopesAt(line, 0)).not.toContain('punctuation.definition.tag.tsk');
    });

    it('scopes a tag inside a task line', () => {
        const line = '- [ ] do thing #project/test';
        expect(scopesAt(line, 15)).toContain('punctuation.definition.tag.tsk');
        expect(scopesAt(line, 16)).toContain('entity.name.tag.tsk');
    });
});

describe('tsk grammar — markdown inline in task content (M43)', () => {
    // The grammar embeds text.html.markdown so a task's *content* gets Markdown
    // inline styling (code, bold, italic, links). The #task-line wrapper is what
    // makes this work — without it the content falls through to Markdown mid-line,
    // where the block rules (^|\G-anchored) never engage and inline styling is lost.
    //
    // VS Code ships the real text.html.markdown grammar; here it's stubbed with a
    // minimal #inline repository so the test stays hermetic and asserts only the
    // tsk-side wiring (content reaches text.html.markdown#inline while the marker,
    // metadata and tag scopes still win). The real grammar's behaviour is verified
    // out-of-band by a vscode-textmate probe against the bundled markdown grammar on
    // both the stable and 1.112 floor engines (see plan M43).
    let inlineGrammar: IGrammar;

    beforeAll(async () => {
        // WASM is already loaded by the suite-level beforeAll above (loadWASM is
        // once-only); we just build a second registry with a markdown stub that
        // exposes #inline.
        const grammarContent = await fs.readFile(grammarPath, 'utf-8');
        const markdownStub = JSON.stringify({
            name: 'Markdown',
            scopeName: 'text.html.markdown',
            patterns: [{ include: '#inline' }],
            repository: {
                inline: {
                    patterns: [{ include: '#raw' }, { include: '#bold' }, { include: '#italic' }],
                },
                raw: { name: 'markup.inline.raw.string.markdown', match: '`[^`]+`' },
                bold: { name: 'markup.bold.markdown', match: '\\*\\*[^*]+\\*\\*' },
                italic: { name: 'markup.italic.markdown', match: '\\*[^*]+\\*' },
            },
        });

        const registry = new Registry({
            onigLib: Promise.resolve({
                createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
                createOnigString: (s) => new oniguruma.OnigString(s),
            }),
            loadGrammar: async (scopeName) => {
                if (scopeName === 'text.html.markdown.tsk') {
                    return parseRawGrammar(grammarContent, grammarPath);
                }
                if (scopeName === 'text.html.markdown') {
                    return parseRawGrammar(markdownStub, 'markdown-inline-stub.json');
                }
                return null;
            },
        });

        const loaded = await registry.loadGrammar('text.html.markdown.tsk');
        if (!loaded) {
            throw new Error('failed to load tsk grammar (inline harness)');
        }
        inlineGrammar = loaded;
    });

    function scopes(line: string, col: number): string[] {
        const tokens = inlineGrammar.tokenizeLine(line, INITIAL).tokens;
        return tokens.find((t) => t.startIndex <= col && col < t.endIndex)?.scopes ?? [];
    }

    it('highlights an inline code span inside task content', () => {
        const line = '- [ ] ship `v1` today';
        expect(scopes(line, 11)).toContain('markup.inline.raw.string.markdown'); // opening `
        expect(scopes(line, 12)).toContain('markup.inline.raw.string.markdown'); // v1
    });

    it('highlights bold inside task content', () => {
        const line = '- [ ] ship **docs** today';
        expect(scopes(line, 13)).toContain('markup.bold.markdown'); // inside **docs**
    });

    it('highlights italic inside task content', () => {
        const line = '- [/] read *spec* now';
        expect(scopes(line, 12)).toContain('markup.italic.markdown'); // inside *spec*
    });

    it('still scopes the marker triplet on a content-rich task', () => {
        // The #task-marker match rules run first inside the wrapper, so the marker
        // keeps its own scope even though the rest of the line is now Markdown inline.
        const line = '- [x] ship `v1` and **docs**';
        expect(scopes(line, 2)).toContain('punctuation.definition.task-marker.begin.tsk');
        expect(scopes(line, 3)).toContain('markup.task-marker.completed.tsk');
        expect(scopes(line, 4)).toContain('punctuation.definition.task-marker.end.tsk');
    });

    it('keeps metadata winning over markdown inline', () => {
        const line = '- [ ] ship `v1` <!-- @id:abc -->';
        expect(scopes(line, line.indexOf('<!--') + 1)).toContain('comment.block.metadata.tsk');
        // the code span before the comment is still raw, not swallowed
        expect(scopes(line, line.indexOf('`') + 1)).toContain('markup.inline.raw.string.markdown');
    });

    it('keeps #tag winning over markdown inline', () => {
        const line = '- [ ] ship **docs** #project/tsk';
        const hash = line.indexOf('#');
        expect(scopes(line, hash)).toContain('punctuation.definition.tag.tsk');
        expect(scopes(line, hash + 1)).toContain('entity.name.tag.tsk');
    });
});
