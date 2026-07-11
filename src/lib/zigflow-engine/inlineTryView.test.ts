import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/svelte';
import type { ScopeGraph } from './graph';
import {
	composeScopeForDisplay,
	decomposeDisplayedScope,
	computeLiveSyntheticEdges,
	OWNER_SCOPE_TAG,
	SYNTHETIC_TRY_EDGE_TAG
} from './inlineTryView';
import { tryScopeKey, catchScopeKey, ROOT_SCOPE_ID } from './scopeKey';

function node(id: string, type = 'set'): Node {
	return { id, type, position: { x: 0, y: 0 }, data: { label: id } };
}

function chain(ids: string[]): Edge[] {
	const edges: Edge[] = [];
	for (let i = 0; i < ids.length - 1; i++) {
		edges.push({ id: `e-${ids[i]}-${ids[i + 1]}`, source: ids[i], target: ids[i + 1] });
	}
	return edges;
}

describe('composeScopeForDisplay', () => {
	it('is a pure passthrough for a scope with no try nodes (for/fork/plain do unaffected)', () => {
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node('start', 'start'), node('a', 'set'), node('b', 'for')],
				edges: chain(['start', 'a', 'b'])
			}
		};
		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		expect(result.nodes.map((n) => n.id)).toEqual(['start', 'a', 'b']);
		expect(
			result.edges.filter((e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_TRY_EDGE_TAG])
		).toHaveLength(0);
		for (const n of result.nodes) {
			expect((n.data as Record<string, unknown>)[OWNER_SCOPE_TAG]).toBe(ROOT_SCOPE_ID);
		}
	});

	it("inlines a try node's try/catch scopes as tagged siblings with synthetic labeled edges", () => {
		const tryId = 'try1';
		const tryKey = tryScopeKey(ROOT_SCOPE_ID, tryId);
		const catchKey = catchScopeKey(ROOT_SCOPE_ID, tryId);
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node('start', 'start'), node(tryId, 'try')],
				edges: chain(['start', tryId])
			},
			[tryKey]: { nodes: [node('httpCall', 'call')], edges: [] },
			[catchKey]: { nodes: [node('setCatch', 'set')], edges: [] }
		};

		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);

		expect(result.nodes.map((n) => n.id).sort()).toEqual(
			['httpCall', 'setCatch', 'start', tryId].sort()
		);
		const httpCallNode = result.nodes.find((n) => n.id === 'httpCall')!;
		expect((httpCallNode.data as Record<string, unknown>)[OWNER_SCOPE_TAG]).toBe(tryKey);
		const setCatchNode = result.nodes.find((n) => n.id === 'setCatch')!;
		expect((setCatchNode.data as Record<string, unknown>)[OWNER_SCOPE_TAG]).toBe(catchKey);

		const synthetic = result.edges.filter(
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_TRY_EDGE_TAG]
		);
		expect(synthetic).toHaveLength(2);
		expect(synthetic.find((e) => e.label === 'try')?.target).toBe('httpCall');
		expect(synthetic.find((e) => e.label === 'catch')?.target).toBe('setCatch');
		expect(synthetic.every((e) => e.deletable === false && e.selectable === false)).toBe(true);

		expect(result.tryBounds.has(tryId)).toBe(true);
		expect(result.catchBounds.has(tryId)).toBe(true);
	});

	it('omits the synthetic edge for an empty lane', () => {
		const tryId = 'try1';
		const tryKey = tryScopeKey(ROOT_SCOPE_ID, tryId);
		const catchKey = catchScopeKey(ROOT_SCOPE_ID, tryId);
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: { nodes: [node(tryId, 'try')], edges: [] },
			[tryKey]: { nodes: [node('onlyTry')], edges: [] },
			[catchKey]: { nodes: [], edges: [] }
		};
		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		const synthetic = result.edges.filter(
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_TRY_EDGE_TAG]
		);
		expect(synthetic).toHaveLength(1);
		expect(synthetic[0].label).toBe('try');
	});

	it('handles two try nodes in the same scope without cross-contaminating tags', () => {
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node('try1', 'try'), node('try2', 'try')],
				edges: chain(['try1', 'try2'])
			},
			[tryScopeKey(ROOT_SCOPE_ID, 'try1')]: { nodes: [node('a1')], edges: [] },
			[catchScopeKey(ROOT_SCOPE_ID, 'try1')]: { nodes: [node('c1')], edges: [] },
			[tryScopeKey(ROOT_SCOPE_ID, 'try2')]: { nodes: [node('a2')], edges: [] },
			[catchScopeKey(ROOT_SCOPE_ID, 'try2')]: { nodes: [node('c2')], edges: [] }
		};
		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		const tagOf = (id: string) =>
			(result.nodes.find((n) => n.id === id)!.data as Record<string, unknown>)[OWNER_SCOPE_TAG];
		expect(tagOf('a1')).toBe(tryScopeKey(ROOT_SCOPE_ID, 'try1'));
		expect(tagOf('c1')).toBe(catchScopeKey(ROOT_SCOPE_ID, 'try1'));
		expect(tagOf('a2')).toBe(tryScopeKey(ROOT_SCOPE_ID, 'try2'));
		expect(tagOf('c2')).toBe(catchScopeKey(ROOT_SCOPE_ID, 'try2'));
	});
});

describe('decomposeDisplayedScope', () => {
	it('round-trips with composeScopeForDisplay (compose then decompose reconstructs the scopes)', () => {
		const tryId = 'try1';
		const tryKey = tryScopeKey(ROOT_SCOPE_ID, tryId);
		const catchKey = catchScopeKey(ROOT_SCOPE_ID, tryId);
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node('start', 'start'), node(tryId, 'try')],
				edges: chain(['start', tryId])
			},
			[tryKey]: { nodes: [node('httpCall', 'call')], edges: [] },
			[catchKey]: { nodes: [node('setCatch', 'set')], edges: [] }
		};

		const composed = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		const decomposed = decomposeDisplayedScope(composed.nodes, composed.edges);

		expect(decomposed[ROOT_SCOPE_ID].nodes.map((n) => n.id).sort()).toEqual(['start', tryId]);
		expect(decomposed[tryKey].nodes.map((n) => n.id)).toEqual(['httpCall']);
		expect(decomposed[catchKey].nodes.map((n) => n.id)).toEqual(['setCatch']);
		// the internal ownership tag must not leak into the persisted node data
		for (const scope of Object.values(decomposed)) {
			for (const n of scope.nodes) {
				expect((n.data as Record<string, unknown>)[OWNER_SCOPE_TAG]).toBeUndefined();
			}
		}
	});

	it('never includes synthetic try/catch edges in the decomposed output', () => {
		const tryId = 'try1';
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: { nodes: [node(tryId, 'try')], edges: [] },
			[tryScopeKey(ROOT_SCOPE_ID, tryId)]: {
				nodes: [node('a1'), node('a2')],
				edges: chain(['a1', 'a2'])
			},
			[catchScopeKey(ROOT_SCOPE_ID, tryId)]: { nodes: [node('c')], edges: [] }
		};
		const composed = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		// sanity: the composed view really does contain synthetic edges to begin with
		const syntheticInComposed = composed.edges.filter(
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_TRY_EDGE_TAG]
		);
		expect(syntheticInComposed.length).toBeGreaterThan(0);

		const decomposed = decomposeDisplayedScope(composed.nodes, composed.edges);
		const allDecomposedEdges = Object.values(decomposed).flatMap((s) => s.edges);
		expect(allDecomposedEdges.length).toBeGreaterThan(0); // the real a1->a2 edge did survive
		expect(
			allDecomposedEdges.some(
				(e) => (e.data as Record<string, unknown> | undefined)?.[SYNTHETIC_TRY_EDGE_TAG]
			)
		).toBe(false);
	});

	it('returns a partial map that must be merged, not used to replace scopes wholesale', () => {
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: { nodes: [node('start', 'start')], edges: [] },
			'unrelated/for-scope/do': { nodes: [node('loopStep')], edges: [] }
		};
		const composed = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		const decomposed = decomposeDisplayedScope(composed.nodes, composed.edges);

		// decomposeDisplayedScope only knows about what's in the displayed view — it correctly has
		// no idea the unrelated scope exists...
		expect(decomposed['unrelated/for-scope/do']).toBeUndefined();

		// ...so callers MUST merge over the previous `scopes`, never replace, or this would be lost:
		const merged = { ...scopes, ...decomposed };
		expect(merged['unrelated/for-scope/do']).toBeDefined();
		expect(merged['unrelated/for-scope/do'].nodes.map((n) => n.id)).toEqual(['loopStep']);
	});
});

describe('computeLiveSyntheticEdges', () => {
	it('produces a synthetic edge for a node freshly tagged into a lane after the initial compose', () => {
		// Simulates dropping a REST node into an already-composed (previously empty) try-lane:
		// `nodes` gains a new tagged entry without going through `composeScopeForDisplay` again.
		const tryKey = tryScopeKey(ROOT_SCOPE_ID, 'try1');
		const tryNode: Node = {
			id: 'try1',
			type: 'try',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		const droppedIntoTryLane: Node = {
			id: 'newCall',
			type: 'call',
			position: { x: 260, y: 120 },
			data: { [OWNER_SCOPE_TAG]: tryKey }
		};

		const edges = computeLiveSyntheticEdges([tryNode, droppedIntoTryLane], []);
		expect(edges).toHaveLength(1);
		expect(edges[0].label).toBe('try');
		expect(edges[0].source).toBe('try1');
		expect(edges[0].target).toBe('newCall');
		// catch lane still empty -> no synthetic edge for it
		expect(edges.some((e) => e.label === 'catch')).toBe(false);
	});

	it('orders a multi-node lane by its internal edges to pick the correct first node', () => {
		const tryKey = tryScopeKey(ROOT_SCOPE_ID, 'try1');
		const tryNode: Node = {
			id: 'try1',
			type: 'try',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		const second: Node = {
			id: 'second',
			type: 'set',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: tryKey }
		};
		const first: Node = {
			id: 'first',
			type: 'set',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: tryKey }
		};
		const laneEdge: Edge = { id: 'e-first-second', source: 'first', target: 'second' };

		const synthetic = computeLiveSyntheticEdges([tryNode, second, first], [laneEdge]);
		const tryEdge = synthetic.find((e) => e.label === 'try');
		expect(tryEdge?.target).toBe('first');
	});
});
