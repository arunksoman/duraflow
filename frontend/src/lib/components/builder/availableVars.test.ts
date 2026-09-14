import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/svelte';
import { computeAvailableVars } from './availableVars';
import { OWNER_SCOPE_TAG } from '$lib/zigflow-engine/inlineScopeView';
import { catchScopeKey, forScopeKey, ROOT_SCOPE_ID } from '$lib/zigflow-engine/scopeKey';
import { refToJq } from '$lib/zigflow-engine/expression';

function node(
	id: string,
	type: string,
	data: Record<string, unknown> = {},
	scope = ROOT_SCOPE_ID
): Node {
	return {
		id,
		type,
		position: { x: 0, y: 0 },
		data: { label: id, ...data, [OWNER_SCOPE_TAG]: scope }
	};
}

function edge(source: string, target: string): Edge {
	return { id: `${source}-${target}`, source, target };
}

function refs(target: Node, nodes: Node[], edges: Edge[], meta = {}): string[] {
	return computeAvailableVars(target, nodes, edges, meta).map((v) => refToJq(v.source, v.path));
}

describe('computeAvailableVars', () => {
	it('offers only what upstream tasks produce', () => {
		const start = node('start', 'start', { variables: [{ key: 'count', value: '0' }] });
		const set = node('setUser', 'set', { variables: [{ key: 'user', value: '${ $input.user }' }] });
		const call = node('Fetch Profile', 'call', {
			exportAs: '${ $context + { profile: . } }'
		});
		const target = node('target', 'set');
		const later = node('later', 'set', { variables: [{ key: 'notYet', value: '1' }] });
		const nodes = [start, set, call, target, later];
		const edges = [
			edge('start', 'setUser'),
			edge('setUser', 'Fetch Profile'),
			edge('Fetch Profile', 'target'),
			edge('target', 'later')
		];

		const out = refs(target, nodes, edges, {
			inputSchema: [{ name: 'userId', type: 'string' }],
			envVars: [{ name: 'API_BASE' }]
		});
		expect(out).toEqual(
			expect.arrayContaining([
				'$input',
				'$input.userId',
				'$data.count',
				'$data.user',
				'$data.fetchProfile',
				'$context',
				'$context.profile',
				'.',
				'$output',
				'$env',
				'$env.API_BASE'
			])
		);
		expect(out).not.toContain('$data.notYet');
	});

	it('adds loop variables and the caught error for tasks inside those lanes', () => {
		const loop = node('loop', 'for', { each: 'user', at: 'i' });
		const guarded = node('guarded', 'try', { catchAs: 'err' }, forScopeKey(ROOT_SCOPE_ID, 'loop'));
		const handler = node(
			'handler',
			'set',
			{},
			catchScopeKey(forScopeKey(ROOT_SCOPE_ID, 'loop'), 'guarded')
		);
		const out = refs(handler, [loop, guarded, handler], []);
		expect(out).toEqual(
			expect.arrayContaining(['$data.user', '$data.i', '$data.err', '$data.err.status'])
		);

		const outside = node('outside', 'set');
		expect(refs(outside, [loop, guarded, handler, outside], [])).not.toContain('$data.user');
	});

	it('never lists the same reference twice', () => {
		const a = node('a', 'set', { variables: [{ key: 'x', value: '1' }] });
		const b = node('b', 'set', { variables: [{ key: 'x', value: '2' }] });
		const t = node('t', 'set');
		const out = refs(t, [a, b, t], [edge('a', 'b'), edge('b', 't')]);
		expect(out.filter((r) => r === '$data.x')).toHaveLength(1);
	});
});
