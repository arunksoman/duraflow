/**
 * Which runtime variables a node's expression fields can reference, for autocomplete. Pure — no
 * Svelte — so it is unit-testable alongside the engine.
 *
 * What a task can see depends on where it sits: tasks that run before it (on any path into it)
 * contribute `$data` keys, task results and `$context` keys; enclosing `for` loops add their
 * item/index variables and an enclosing `catch` adds the caught error.
 */

import type { Edge, Node } from '@xyflow/svelte';
import type { InputField, EnvVar } from '$lib/types';
import type { VarEntry } from './builderConfig';
import { OWNER_SCOPE_TAG } from '$lib/zigflow-engine/inlineScopeView';
import { ROOT_SCOPE_ID } from '$lib/zigflow-engine/scopeKey';
import { toTaskName } from '$lib/zigflow-engine/slug';
import { refToJq, type PathSegment, type VarSource } from '$lib/zigflow-engine/expression';
import { parseExportAs } from '$lib/zigflow-engine/dataFlow';

export interface AvailVar {
	source: VarSource;
	path: PathSegment[];
	/** Short description shown beside the suggestion. */
	hint: string;
	/** Declared value type, when known (from the `$input` schema). */
	type?: string;
}

/** Task types whose result zigflow stores under `$data.<taskName>`. */
const RESULT_TASK_TYPES = new Set(['call', 'grpcCall', 'run', 'childWorkflow', 'for']);

const ERROR_FIELDS = ['type', 'status', 'title', 'detail', 'instance'];

function ownerScope(node: Node): string {
	return (
		((node.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as string) ??
		ROOT_SCOPE_ID
	);
}

function label(node: Node): string {
	return ((node.data?.label as string) ?? node.type ?? 'task').trim();
}

/** Every node that can run before `nodeId`, following edges backwards (synthetic lane edges included). */
function upstreamIds(nodeId: string, edges: Edge[]): Set<string> {
	const seen = new Set<string>();
	const queue = [nodeId];
	while (queue.length > 0) {
		const curr = queue.shift()!;
		for (const e of edges) {
			if (e.target === curr && !seen.has(e.source) && e.source !== nodeId) {
				seen.add(e.source);
				queue.push(e.source);
			}
		}
	}
	return seen;
}

/**
 * The containers enclosing a scope, outermost first: `root/<forId>/do/<tryId>/catch` →
 * `[{ nodeId: forId, lane: 'do' }, { nodeId: tryId, lane: 'catch' }]`.
 */
function enclosingLanes(scopeId: string): { nodeId: string; lane: string }[] {
	const parts = scopeId.split('/').slice(1);
	const out: { nodeId: string; lane: string }[] = [];
	let i = 0;
	while (i + 1 < parts.length) {
		const nodeId = parts[i];
		const lane = parts[i + 1];
		out.push({ nodeId, lane });
		i += lane === 'branch' ? 3 : 2;
	}
	return out;
}

export function computeAvailableVars(
	node: Node,
	nodes: Node[],
	edges: Edge[],
	meta: { inputSchema?: InputField[]; envVars?: EnvVar[] }
): AvailVar[] {
	const vars: AvailVar[] = [];
	const byId = new Map(nodes.map((n) => [n.id, n]));

	// ── $input ──
	const inputFields = (meta.inputSchema ?? []).filter((f) => f.name);
	vars.push({ source: 'input', path: [], hint: 'workflow input' });
	for (const f of inputFields) {
		vars.push({
			source: 'input',
			path: [f.name],
			hint: f.example ? `${f.type} · e.g. ${f.example}` : f.type,
			type: f.type
		});
	}

	// ── enclosing loops / catch blocks ──
	for (const { nodeId, lane } of enclosingLanes(ownerScope(node))) {
		const container = byId.get(nodeId);
		if (!container) continue;
		if (container.type === 'for' && lane === 'do') {
			const each = ((container.data?.each as string) || 'item').trim();
			const at = ((container.data?.at as string) || 'index').trim();
			vars.push({ source: 'data', path: [each], hint: `loop item · ${label(container)}` });
			vars.push({
				source: 'data',
				path: [at],
				hint: `loop index · ${label(container)}`,
				type: 'number'
			});
		}
		if (container.type === 'try' && lane === 'catch') {
			const as = ((container.data?.catchAs as string) || 'error').trim();
			vars.push({ source: 'data', path: [as], hint: `caught error · ${label(container)}` });
			for (const field of ERROR_FIELDS) {
				vars.push({ source: 'data', path: [as, field], hint: 'caught error' });
			}
		}
	}

	// ── $data from Start init values and upstream tasks ──
	const startNode = nodes.find((n) => n.type === 'start');
	for (const v of (startNode?.data?.variables as VarEntry[] | undefined) ?? []) {
		if (v.key.trim()) vars.push({ source: 'data', path: [v.key.trim()], hint: 'initial value' });
	}

	const upstream = upstreamIds(node.id, edges);
	const contextKeys: AvailVar[] = [];
	for (const n of nodes) {
		if (!upstream.has(n.id) || n.type === 'start' || n.type === 'end') continue;
		if (n.type === 'set') {
			for (const v of (n.data?.variables as VarEntry[] | undefined) ?? []) {
				if (v.key.trim())
					vars.push({ source: 'data', path: [v.key.trim()], hint: `set by ${label(n)}` });
			}
		}
		if (RESULT_TASK_TYPES.has(n.type ?? '')) {
			vars.push({ source: 'data', path: [toTaskName(label(n))], hint: `result of ${label(n)}` });
		}
		const exported = parseExportAs((n.data?.exportAs as string) ?? '');
		if (exported.mode === 'merge') {
			for (const f of exported.fields) {
				contextKeys.push({ source: 'context', path: [f.key], hint: `exported by ${label(n)}` });
			}
		}
	}

	// ── $context ──
	vars.push({ source: 'context', path: [], hint: 'workflow context' });
	vars.push(...contextKeys);

	// ── previous output ──
	vars.push({ source: 'dot', path: [], hint: 'current value' });
	vars.push({ source: 'output', path: [], hint: 'task output' });

	// ── $env ──
	vars.push({ source: 'env', path: [], hint: 'ZIGGY_* worker env' });
	for (const e of meta.envVars ?? []) {
		if (e.name) {
			vars.push({
				source: 'env',
				path: [e.name],
				hint: e.description || (e.example ? `e.g. ${e.example}` : 'env var')
			});
		}
	}

	// First occurrence wins — the most specific hint is pushed first.
	const seen = new Set<string>();
	return vars.filter((v) => {
		const key = refToJq(v.source, v.path);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
