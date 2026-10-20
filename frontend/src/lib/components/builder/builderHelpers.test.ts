import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/svelte';
import type { WorkflowMeta } from '$lib/types';
import {
	CATEGORY_LABELS,
	NODE_META,
	NODE_TYPES,
	freshNodeData,
	type CaseEntry
} from './builderConfig';
import { availableVarsAt } from './availableVars';

describe('node catalogue', () => {
	it('describes every node type with a known category', () => {
		expect(NODE_TYPES.length).toBeGreaterThan(10);
		for (const type of NODE_TYPES) {
			const meta = NODE_META[type];
			expect(meta.label, type).toBeTruthy();
			expect(CATEGORY_LABELS[meta.category], `${type} category`).toBeTruthy();
		}
	});

	it('never shows End in the palette, but does show Start', () => {
		expect(NODE_META.end.showInPalette).toBeFalsy();
		expect(NODE_META.start.showInPalette).toBe(true);
	});

	it('hands out independent copies of default data', () => {
		for (const type of NODE_TYPES) {
			const a = freshNodeData(type);
			const b = freshNodeData(type);
			expect(withoutCaseIds(a)).toEqual(withoutCaseIds(b));
			for (const [key, value] of Object.entries(a)) {
				if (Array.isArray(value) && value.length) {
					expect(value, `${type}.${key}`).not.toBe(b[key]);
					if (typeof value[0] === 'object') expect(value[0]).not.toBe((b[key] as unknown[])[0]);
				}
			}
		}
	});

	it('gives each new switch case its own id', () => {
		const a = freshNodeData('switch').cases as CaseEntry[];
		const b = freshNodeData('switch').cases as CaseEntry[];
		expect(a.length).toBeGreaterThan(0);
		expect(a[0].id).not.toBe(b[0].id);
	});
});

/** Switch case ids differ by design; compare everything else. */
function withoutCaseIds(data: Record<string, unknown>) {
	if (!Array.isArray(data.cases)) return data;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	return { ...data, cases: (data.cases as CaseEntry[]).map(({ id, ...rest }) => rest) };
}

const node = (id: string, type: string, data: Record<string, unknown> = {}) =>
	({ id, type, data, position: { x: 0, y: 0 } }) as Node;
const edge = (source: string, target: string) =>
	({ id: `${source}-${target}`, source, target }) as Edge;
const exprs = (vars: { expr: string }[]) => vars.map((v) => v.expr);

describe('availableVarsAt', () => {
	const meta = (extra: Partial<WorkflowMeta> = {}) => ({ ...extra }) as WorkflowMeta;

	it('offers the whole $input and the previous output when nothing is declared', () => {
		const vars = availableVarsAt(undefined, [], [], meta());
		expect(exprs(vars)).toEqual(['${ $input }', '${ . }', '${ $output }']);
	});

	it('lists declared inputs and env vars', () => {
		const vars = availableVarsAt(
			undefined,
			[],
			[],
			meta({
				inputSchema: [
					{ name: 'orderId', type: 'string', example: 'o-1' },
					{ name: 'count' }
				] as never,
				envVars: [
					{ name: 'API_KEY', example: 'xyz' },
					{ name: 'REGION', description: 'where' },
					{ name: 'BARE' }
				] as never
			})
		);
		expect(vars.find((v) => v.field === 'orderId')).toMatchObject({
			expr: '${ $input.orderId }',
			hint: 'e.g. o-1',
			category: 'input'
		});
		expect(vars.find((v) => v.field === 'count')?.hint).toBe('string');
		expect(vars.find((v) => v.field === 'API_KEY')?.hint).toBe('e.g. xyz');
		expect(vars.find((v) => v.field === 'REGION')?.hint).toBe('where');
		expect(vars.find((v) => v.field === 'BARE')?.hint).toBe('');
		expect(exprs(vars)).not.toContain('${ $input }');
	});

	it('collects $data from Start and every upstream set, and $context from exports', () => {
		const nodes = [
			node('start', 'start', { variables: [{ key: 'seed' }, { key: '' }] }),
			node('a', 'set', { label: 'Prepare', variables: [{ key: 'total' }] }),
			node('b', 'call', { exportAs: '.' }),
			node('c', 'set', { variables: [{ key: 'unlabelled' }] }),
			node('downstream', 'set', { variables: [{ key: 'later' }] }),
			node('target', 'set')
		];
		const edges = [
			edge('start', 'a'),
			edge('a', 'b'),
			edge('b', 'c'),
			edge('c', 'target'),
			edge('target', 'downstream'),
			edge('a', 'c') // a diamond: a is reached twice
		];
		const vars = availableVarsAt(nodes[5], nodes, edges, meta());
		const data = vars.filter((v) => v.category === 'data');
		expect(data.map((v) => [v.field, v.hint])).toEqual([
			['seed', 'from Start init'],
			['total', 'from Set: Prepare'],
			['unlabelled', 'from Set: Set']
		]);
		expect(exprs(vars)).toContain('${ $context }');
	});

	it('uses the named workflow’s own Start when the node is inside one', () => {
		const nodes = [
			node('start', 'start', { variables: [{ key: 'primary' }] }),
			node('wf', 'start', { variables: [{ key: 'param' }] }),
			node('step', 'set')
		];
		const vars = availableVarsAt(nodes[2], nodes, [edge('wf', 'step')], meta());
		expect(vars.filter((v) => v.category === 'data').map((v) => v.field)).toEqual(['param']);
		expect(exprs(vars)).not.toContain('${ $context }');
	});
});
