import { ALPHABET, ID_LENGTH } from './ids';
import type { Marker } from './markers';

/**
 * `tsk:<id>`, as plans name their tasks — read by the TUI's detail pane and by
 * the editor's links and markers. Pure.
 */
export const TSK_REF = /\btsk:([A-Za-z0-9_-]+)/g;

export interface TaskRef {
    readonly id: string;
    /** Offsets of the whole `tsk:<id>` token in its line. */
    readonly start: number;
    readonly end: number;
}

export function taskRefsIn(line: string): TaskRef[] {
    return [...line.matchAll(TSK_REF)].map((m) => ({
        id: m[1] as string,
        start: m.index,
        end: m.index + m[0].length,
    }));
}

const GENERATED_ID_RE = new RegExp(`^[${ALPHABET}]{${ID_LENGTH}}$`);

/** An id the generator could have made: `ID_LENGTH` characters of its alphabet. */
export function isGeneratedIdShape(id: string): boolean {
    return GENERATED_ID_RE.test(id);
}

export interface ShownRef extends TaskRef {
    /** The task's marker; `undefined` when no `.tsk` file has the id. */
    readonly marker: Marker | undefined;
}

/**
 * Whether a ref is worth a link and a marker: every id the workspace knows,
 * whatever its shape (hand-written `@id`s are fine), and an unknown one only
 * when it looks generated — a typo or a deleted task to flag, where
 * `task tsk:test` in prose is nothing of the kind.
 */
export function isShownRef(id: string, marker: Marker | undefined): boolean {
    return marker !== undefined || isGeneratedIdShape(id);
}

/** The refs on `line` {@link isShownRef} keeps. */
export function shownRefs(line: string, markerOf: (id: string) => Marker | undefined): ShownRef[] {
    const out: ShownRef[] = [];
    for (const ref of taskRefsIn(line)) {
        const marker = markerOf(ref.id);
        if (isShownRef(ref.id, marker)) out.push({ ...ref, marker });
    }
    return out;
}
