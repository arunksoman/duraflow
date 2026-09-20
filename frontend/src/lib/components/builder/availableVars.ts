import type { Node, Edge } from '@xyflow/svelte';
import type { WorkflowMeta } from '$lib/types';
import type { VarEntry } from './builderConfig';

/**
 * One expression a user can insert at a given point in the workflow, as offered by
 * `ExpressionInput`/`ConditionBuilder`'s autocomplete.
 */
export interface AvailVar {
	expr: string;
	hint: string;
	category: 'input' | 'env' | 'data' | 'context' | 'output';
	source: string;
	field: string;
	rawRef: string;
}

/**
 * Everything in scope at `node`: the workflow's `$input` schema and `$env` vars, the previous
 * task's output, and the `$data` keys written by Start and by any `set` task upstream of it.
 *
 * Lives here rather than in `NodePanel` because the switch case editor needs the same list at the
 * same node — a case's condition is evaluated exactly where the switch runs.
 */
export function availableVarsAt(
	node: Node | undefined,
	nodes: Node[],
	edges: Edge[],
	workflowMeta: WorkflowMeta
): AvailVar[] {
	const vars: AvailVar[] = [];

	// $input fields
	for (const field of workflowMeta.inputSchema ?? []) {
		vars.push({
			expr: '${ $input.' + field.name + ' }',
			hint: field.example ? 'e.g. ' + field.example : (field.type ?? 'string'),
			category: 'input',
			source: '$input',
			field: field.name,
			rawRef: '$input.' + field.name
		});
	}
	if ((workflowMeta.inputSchema ?? []).length === 0) {
		vars.push({
			expr: '${ $input }',
			hint: 'full trigger payload',
			category: 'input',
			source: '$input',
			field: '',
			rawRef: '$input'
		});
	}

	// $env vars
	for (const e of workflowMeta.envVars ?? []) {
		vars.push({
			expr: '${ $env.' + e.name + ' }',
			hint: e.example ? 'e.g. ' + e.example : (e.description ?? ''),
			category: 'env',
			source: '$env',
			field: e.name,
			rawRef: '$env.' + e.name
		});
	}

	// $output (always)
	vars.push({
		expr: '${ . }',
		hint: 'previous task output (shorthand)',
		category: 'output',
		source: '.',
		field: '',
		rawRef: '.'
	});
	vars.push({
		expr: '${ $output }',
		hint: 'previous task full output',
		category: 'output',
		source: '$output',
		field: '',
		rawRef: '$output'
	});

	// $data keys from upstream Set nodes (and start node vars)
	const ancestors: string[] = [];
	const queue = node ? [node.id] : [];
	while (queue.length > 0) {
		const curr = queue.shift()!;
		for (const edge of edges) {
			if (edge.target === curr && !ancestors.includes(edge.source)) {
				ancestors.push(edge.source);
				queue.push(edge.source);
			}
		}
	}

	const startNode = nodes.find((n) => n.type === 'start');
	if (startNode) {
		for (const v of (startNode.data?.variables as VarEntry[]) ?? []) {
			if (v.key)
				vars.push({
					expr: '${ $data.' + v.key + ' }',
					hint: 'from Start init',
					category: 'data',
					source: '$data',
					field: v.key,
					rawRef: '$data.' + v.key
				});
		}
	}

	for (const n of nodes) {
		if (ancestors.includes(n.id) && n.type === 'set') {
			for (const v of (n.data?.variables as VarEntry[]) ?? []) {
				if (v.key)
					vars.push({
						expr: '${ $data.' + v.key + ' }',
						hint: 'from Set: ' + (n.data?.label ?? 'Set'),
						category: 'data',
						source: '$data',
						field: v.key,
						rawRef: '$data.' + v.key
					});
			}
		}
	}

	// $context hint (when upstream nodes have export.as)
	const hasExports = ancestors.some((aid) => {
		const an = nodes.find((n) => n.id === aid);
		return an && (an.data?.exportAs as string);
	});
	if (hasExports) {
		vars.push({
			expr: '${ $context }',
			hint: 'accumulated via export.as',
			category: 'context',
			source: '$context',
			field: '',
			rawRef: '$context'
		});
	}

	return vars;
}
