import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import type { Document as YamlDocument, Node } from 'yaml';
import { validateZigflowDocument } from './validate';
import type { ForkTask, ForTask, TaskList, TaskNode, TryTask, ZigflowDocument } from './ast';

export interface SourceRange {
	start: number;
	end: number;
}

export interface DeserializeError {
	path: string;
	message: string;
	range?: SourceRange;
}

export type DeserializeResult =
	| { ok: true; document: ZigflowDocument; warnings: string[] }
	| { ok: false; errors: DeserializeError[] };

// ── JSON-pointer -> YAML source range ────────────────────────────────────

function pointerToPath(pointer: string): (string | number)[] {
	if (!pointer || pointer === '/') return [];
	return pointer
		.split('/')
		.slice(1)
		.map((seg) => {
			const decoded = seg.replace(/~1/g, '/').replace(/~0/g, '~');
			return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
		});
}

function nodeRange(node: unknown): SourceRange | undefined {
	if (isMap(node) || isSeq(node) || isScalar(node)) {
		const n = node as Node;
		if (n.range) return { start: n.range[0], end: n.range[1] };
	}
	return undefined;
}

/** Walk up the path until a node with a source range is found (handles "missing property" errors). */
function resolveRange(doc: YamlDocument, pointer: string): SourceRange | undefined {
	const path = pointerToPath(pointer);
	for (let len = path.length; len >= 0; len--) {
		const sub = path.slice(0, len);
		const node = sub.length === 0 ? doc.contents : doc.getIn(sub, true);
		const range = nodeRange(node);
		if (range) return range;
	}
	return undefined;
}

// ── Defaults normalization (schema-declared defaults, for round-trip fidelity) ──

function normalizeTaskList(list: TaskList): void {
	for (const entry of list) {
		for (const task of Object.values(entry)) normalizeTask(task);
	}
}

function normalizeTask(task: TaskNode): void {
	if ('for' in task) {
		const t = task as ForTask;
		t.for.each ??= 'item';
		t.for.at ??= 'index';
		normalizeTaskList(t.do);
	} else if ('fork' in task) {
		const t = task as ForkTask;
		t.fork.compete ??= false;
		normalizeTaskList(t.fork.branches);
	} else if ('try' in task) {
		const t = task as TryTask;
		t.catch.as ??= 'error';
		normalizeTaskList(t.try);
		normalizeTaskList(t.catch.do);
	} else if ('do' in task) {
		normalizeTaskList(task.do);
	}
}

// ── Public entry point ───────────────────────────────────────────────────

export function deserializeZigflowDocument(yamlText: string): DeserializeResult {
	const doc = parseDocument(yamlText, { strict: false });

	if (doc.errors.length > 0) {
		return {
			ok: false,
			errors: doc.errors.map((e) => ({
				path: '/',
				message: e.message,
				range: e.pos ? { start: e.pos[0], end: e.pos[1] } : undefined
			}))
		};
	}

	const plain = doc.toJS({ maxAliasCount: -1 }) ?? {};
	const result = validateZigflowDocument(plain);
	if (!result.valid) {
		return {
			ok: false,
			errors: result.errors.map((e) => ({
				path: e.path,
				message: e.message,
				range: resolveRange(doc, e.path)
			}))
		};
	}

	const zigflowDoc = plain as ZigflowDocument;
	normalizeTaskList(zigflowDoc.do);

	// `warnings` is a hook for future diagnostics (e.g. round-trip caveats); none are raised
	// today. Note: whether a document's top-level `do:` list represents "one workflow with a
	// flat task sequence" vs. Zigflow's "multiple named workflows" feature is not reliably
	// decidable from structure alone (both are literally `TaskList`s) — the builder always
	// treats the top-level `do:` as a single workflow's root scope, which is a safe, consistent
	// interpretation either way (see the `ZigflowDocument` doc comment in ast.ts).
	const warnings: string[] = [];

	return { ok: true, document: zigflowDoc, warnings };
}
