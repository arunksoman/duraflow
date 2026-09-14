/**
 * Guided editing for a task's `output.as` and `export.as`. Both are stored on the node as a single
 * string (see `graph.ts`'s `parseAsField`); this module recognises the common shapes so the panel
 * can offer a key/value editor instead of hand-written jq, and falls back to a free expression for
 * anything else.
 *
 * - output "fields": an object literal whose values are field values, stored as its JSON text —
 *   `{"user":"${ .user }"}` → `output: { as: { user: ${ .user } } }`.
 * - export "merge": `${ $context + { key: <jq>, ... } }` — adds keys to the workflow context
 *   without discarding what earlier tasks exported.
 */

import { splitTopLevel, stripOuterParens, unwrapTemplate } from './expression';

export interface KeyValue {
	key: string;
	value: string;
}

export type OutputMode = 'default' | 'fields' | 'custom';
export type ExportMode = 'none' | 'merge' | 'custom';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseOutputAs(raw: string): { mode: OutputMode; fields: KeyValue[] } {
	const t = (raw ?? '').trim();
	if (!t) return { mode: 'default', fields: [] };
	if (t.startsWith('{')) {
		try {
			const obj = JSON.parse(t) as unknown;
			if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
				const entries = Object.entries(obj as Record<string, unknown>);
				if (entries.every(([, v]) => typeof v === 'string')) {
					return {
						mode: 'fields',
						fields: entries.map(([key, value]) => ({ key, value: value as string }))
					};
				}
			}
		} catch {
			// Not JSON — a jq object construction, edited as a custom expression.
		}
	}
	return { mode: 'custom', fields: [] };
}

export function serializeOutputFields(fields: KeyValue[]): string {
	const live = fields.filter((f) => f.key.trim());
	if (live.length === 0) return '';
	return JSON.stringify(Object.fromEntries(live.map((f) => [f.key.trim(), f.value])));
}

function parseKey(raw: string): string | null {
	const t = raw.trim();
	if (IDENT_RE.test(t)) return t;
	if (/^"(?:[^"\\]|\\.)*"$/.test(t)) {
		try {
			return JSON.parse(t) as string;
		} catch {
			return null;
		}
	}
	return null;
}

/** Parses the entries of a jq object construction body (`a: 1, "b": $x`), or `null`. */
function parseObjectBody(body: string): KeyValue[] | null {
	if (!body.trim()) return [];
	const entries = splitTopLevel(body, ',');
	if (!entries) return null;
	const out: KeyValue[] = [];
	for (const entry of entries) {
		const colon = findTopLevelColon(entry);
		if (colon < 0) return null;
		const key = parseKey(entry.slice(0, colon));
		const value = entry.slice(colon + 1).trim();
		if (key === null || !value) return null;
		out.push({ key, value: stripOuterParens(value) ?? value });
	}
	return out;
}

function findTopLevelColon(src: string): number {
	let depth = 0;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === '"') {
			for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		else if (ch === ':' && depth === 0) return i;
	}
	return -1;
}

export function parseExportAs(raw: string): { mode: ExportMode; fields: KeyValue[] } {
	const t = (raw ?? '').trim();
	if (!t) return { mode: 'none', fields: [] };
	const jq = unwrapTemplate(t);
	const m = /^\$context\s*\+\s*(\{[\s\S]*\})$/.exec(jq);
	if (m) {
		const body = stripObjectBraces(m[1]);
		const fields = body === null ? null : parseObjectBody(body);
		if (fields) return { mode: 'merge', fields };
	}
	return { mode: 'custom', fields: [] };
}

function stripObjectBraces(src: string): string | null {
	const t = src.trim();
	if (!t.startsWith('{') || !t.endsWith('}')) return null;
	const inner = t.slice(1, -1);
	// The braces must match each other, not two separate objects (`{a:1} + {b:2}`).
	return splitTopLevel(inner, ',') === null ? null : inner;
}

function valueToJq(value: string): string {
	const v = value.trim();
	const needsParens =
		(splitTopLevel(v, ',')?.length ?? 1) > 1 || (splitTopLevel(v, '|')?.length ?? 1) > 1;
	return needsParens ? `(${v})` : v;
}

/** `${ $context + { key: <jq>, ... } }`; `''` when no field has both a key and a value. */
export function serializeExportMerge(fields: KeyValue[]): string {
	const live = fields.filter((f) => f.key.trim() && f.value.trim());
	if (live.length === 0) return '';
	const body = live
		.map((f) => {
			const key = f.key.trim();
			return `${IDENT_RE.test(key) ? key : JSON.stringify(key)}: ${valueToJq(f.value)}`;
		})
		.join(', ');
	return `\${ $context + { ${body} } }`;
}
