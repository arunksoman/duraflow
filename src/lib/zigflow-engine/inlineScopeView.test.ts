import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/svelte';
import type { ScopeGraph } from './graph';
import {
	composeScopeForDisplay,
	decomposeDisplayedScope,
	computeLiveSyntheticEdges,
	computeHiddenRealEdgeIds,
	computeTerminalEdges,
	collectDescendantScopeKeysForNode,
	collectDescendantScopeKeysForLaneKey,
	OWNER_SCOPE_TAG,
	SYNTHETIC_SCOPE_EDGE_TAG
} from './inlineScopeView';
import {
	forScopeKey,
	tryScopeKey,
	catchScopeKey,
	forkBranchScopeKey,
	ROOT_SCOPE_ID
} from './scopeKey';

function node(id: string, type = 'set', extraData: Record<string, unknown> = {}): Node {
	return { id, type, position: { x: 0, y: 0 }, data: { label: id, ...extraData } };
}

function chain(ids: string[]): Edge[] {
	const edges: Edge[] = [];
	for (let i = 0; i < ids.length - 1; i++) {
		edges.push({ id: `e-${ids[i]}-${ids[i + 1]}`, source: ids[i], target: ids[i + 1] });
	}
	return edges;
}

describe('composeScopeForDisplay — try (2 fixed lanes, unchanged behavior)', () => {
	it('is a pure passthrough for a scope with no container nodes', () => {
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node('start', 'start'), node('a', 'set')],
				edges: chain(['start', 'a'])
			}
		};
		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		expect(result.nodes.map((n) => n.id)).toEqual(['start', 'a']);
		expect(
			result.edges.filter((e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG])
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
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG]
		);
		expect(synthetic).toHaveLength(2);
		expect(synthetic.find((e) => e.label === 'try')?.target).toBe('httpCall');
		expect(synthetic.find((e) => e.label === 'catch')?.target).toBe('setCatch');
		expect(synthetic.every((e) => e.deletable === false && e.selectable === false)).toBe(true);

		expect(result.laneBounds.has(tryKey)).toBe(true);
		expect(result.laneBounds.has(catchKey)).toBe(true);
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
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG]
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

describe('composeScopeForDisplay — for/do (1 lane, no redirect)', () => {
	it("inlines a for node's body as a single 'body'-labeled lane, with no redirect of the continuation edge", () => {
		const forId = 'for1';
		const bodyKey = forScopeKey(ROOT_SCOPE_ID, forId);
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node('start', 'start'), node(forId, 'for'), node('after', 'set')],
				edges: [...chain(['start', forId]), { id: 'e-for-after', source: forId, target: 'after' }]
			},
			[bodyKey]: { nodes: [node('step', 'set')], edges: [] }
		};

		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);

		const stepNode = result.nodes.find((n) => n.id === 'step')!;
		expect((stepNode.data as Record<string, unknown>)[OWNER_SCOPE_TAG]).toBe(bodyKey);

		const synthetic = result.edges.filter(
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG]
		);
		expect(synthetic).toHaveLength(1);
		expect(synthetic[0].label).toBe('body');
		expect(synthetic[0].source).toBe(forId);
		expect(synthetic[0].target).toBe('step');

		// unlike try, the real for->after edge is NOT redirected/hidden — for/do are genuine
		// pass-throughs, not "maybe diverts but still continues" like try
		const realNext = result.edges.find((e) => e.id === 'e-for-after')!;
		expect(realNext.hidden).toBeFalsy();
		expect(result.laneBounds.has(bodyKey)).toBe(true);
	});
});

describe('composeScopeForDisplay — fork (N lanes, named by branch, no redirect)', () => {
	it('inlines every branch as its own lane labeled with the real branch name, all sourced from the fork control node', () => {
		const forkId = 'fork1';
		const branches = [
			{ id: 'b1', name: 'callNurse' },
			{ id: 'b2', name: 'multiStep' },
			{ id: 'b3', name: 'callDoctor' }
		];
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node(forkId, 'fork', { branches })],
				edges: []
			},
			[forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b1')]: { nodes: [node('callNurse')], edges: [] },
			[forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b2')]: {
				nodes: [node('wait1'), node('wait2')],
				edges: chain(['wait1', 'wait2'])
			},
			[forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b3')]: { nodes: [node('callDoctor')], edges: [] }
		};

		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);

		const synthetic = result.edges.filter(
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG]
		);
		expect(synthetic).toHaveLength(3);
		expect(synthetic.every((e) => e.source === forkId)).toBe(true);
		expect(synthetic.map((e) => e.label).sort()).toEqual(['callDoctor', 'callNurse', 'multiStep']);
		expect(synthetic.find((e) => e.label === 'multiStep')?.target).toBe('wait1');

		for (const b of branches) {
			expect(result.laneBounds.has(forkBranchScopeKey(ROOT_SCOPE_ID, forkId, b.id))).toBe(true);
		}
	});

	it('reflects branch add/remove live with no extra bookkeeping — re-derives from data.branches every call', () => {
		const forkId = 'fork1';
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node(forkId, 'fork', { branches: [{ id: 'b1', name: 'a' }] })],
				edges: []
			},
			[forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b1')]: { nodes: [node('step-a')], edges: [] }
		};

		const before = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		expect(
			before.edges.filter((e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG])
		).toHaveLength(1);

		scopes[ROOT_SCOPE_ID].nodes[0].data = {
			...scopes[ROOT_SCOPE_ID].nodes[0].data,
			branches: [
				{ id: 'b1', name: 'a' },
				{ id: 'b2', name: 'b' }
			]
		};
		scopes[forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b2')] = {
			nodes: [node('step-b')],
			edges: []
		};

		const after = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		expect(
			after.edges.filter((e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG])
		).toHaveLength(2);
	});

	it('connects every open-ended fork branch to the End node, matching the same convention as the main chain', () => {
		const forkId = 'fork1';
		const branches = [
			{ id: 'b1', name: 'callNurse' },
			{ id: 'b2', name: 'callDoctor' }
		];
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node('start', 'start'), node(forkId, 'fork', { branches }), node('end', 'end')],
				edges: [
					{ id: 'e-start-fork', source: 'start', target: forkId },
					{ id: 'e-fork-end', source: forkId, target: 'end' }
				]
			},
			[forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b1')]: { nodes: [node('callNurse')], edges: [] },
			[forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b2')]: { nodes: [node('callDoctor')], edges: [] }
		};

		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		const terminal = result.edges.filter((e) => (e.data as { kind?: string })?.kind === 'terminal');
		expect(terminal).toHaveLength(2);
		expect(terminal.every((e) => e.target === 'end')).toBe(true);
		expect(terminal.map((e) => e.source).sort()).toEqual(['callDoctor', 'callNurse']);
	});
});

describe('composeScopeForDisplay — recursive nesting (arbitrary depth)', () => {
	it('inlines a nested for-loop inside a fork branch, tagged with a scope key nested two levels deep', () => {
		const forkId = 'fork1';
		const forId = 'for1';
		const branchKey = forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b1');
		const nestedBodyKey = forScopeKey(branchKey, forId);

		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node(forkId, 'fork', { branches: [{ id: 'b1', name: 'loopBranch' }] })],
				edges: []
			},
			[branchKey]: { nodes: [node(forId, 'for')], edges: [] },
			[nestedBodyKey]: { nodes: [node('deepStep', 'set')], edges: [] }
		};

		const result = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);

		const deepStep = result.nodes.find((n) => n.id === 'deepStep')!;
		expect((deepStep.data as Record<string, unknown>)[OWNER_SCOPE_TAG]).toBe(nestedBodyKey);
		expect(result.laneBounds.has(nestedBodyKey)).toBe(true);

		// both the branch-entry edge (fork -> for1) and the nested body-entry edge (for1 -> deepStep)
		// must be present, proving the recursion actually reached depth 2, not just depth 1
		const synthetic = result.edges.filter(
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG]
		);
		expect(synthetic.some((e) => e.source === forkId && e.target === forId)).toBe(true);
		expect(synthetic.some((e) => e.source === forId && e.target === 'deepStep')).toBe(true);
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

	it('round-trips a fork branch containing a nested for-loop (2 levels deep)', () => {
		const forkId = 'fork1';
		const forId = 'for1';
		const branchKey = forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b1');
		const nestedBodyKey = forScopeKey(branchKey, forId);
		const scopes: Record<string, ScopeGraph> = {
			[ROOT_SCOPE_ID]: {
				nodes: [node(forkId, 'fork', { branches: [{ id: 'b1', name: 'loopBranch' }] })],
				edges: []
			},
			[branchKey]: { nodes: [node(forId, 'for')], edges: [] },
			[nestedBodyKey]: { nodes: [node('deepStep', 'set')], edges: [] }
		};

		const composed = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		const decomposed = decomposeDisplayedScope(composed.nodes, composed.edges);

		expect(decomposed[ROOT_SCOPE_ID].nodes.map((n) => n.id)).toEqual([forkId]);
		expect(decomposed[branchKey].nodes.map((n) => n.id)).toEqual([forId]);
		expect(decomposed[nestedBodyKey].nodes.map((n) => n.id)).toEqual(['deepStep']);
	});

	it('never includes synthetic edges in the decomposed output', () => {
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
			(e) => (e.data as Record<string, unknown>)?.[SYNTHETIC_SCOPE_EDGE_TAG]
		);
		expect(syntheticInComposed.length).toBeGreaterThan(0);

		const decomposed = decomposeDisplayedScope(composed.nodes, composed.edges);
		const allDecomposedEdges = Object.values(decomposed).flatMap((s) => s.edges);
		expect(allDecomposedEdges.length).toBeGreaterThan(0); // the real a1->a2 edge did survive
		expect(
			allDecomposedEdges.some(
				(e) => (e.data as Record<string, unknown> | undefined)?.[SYNTHETIC_SCOPE_EDGE_TAG]
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

	it('sources the catch edge and the continuation edge from the last try-lane node, not the control node — try/catch is a fallback path, not a fork', () => {
		const tryKey = tryScopeKey(ROOT_SCOPE_ID, 'try1');
		const catchKey = catchScopeKey(ROOT_SCOPE_ID, 'try1');
		const tryNode: Node = {
			id: 'try1',
			type: 'try',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		const httpCall: Node = {
			id: 'httpCall',
			type: 'call',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: tryKey }
		};
		const setCatch: Node = {
			id: 'setCatch',
			type: 'set',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: catchKey }
		};
		const endNode: Node = {
			id: 'end',
			type: 'end',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		const nodes = [tryNode, httpCall, setCatch, endNode];
		const realNextEdge: Edge = { id: 'e-try1-end', source: 'try1', target: 'end' };
		const edges = [realNextEdge];

		const synthetic = computeLiveSyntheticEdges(nodes, edges);
		const tryEdge = synthetic.find((e) => e.label === 'try')!;
		const catchEdge = synthetic.find((e) => e.label === 'catch')!;
		const continueEdge = synthetic.find((e) => (e.data as { kind?: string })?.kind === 'continue')!;

		expect(tryEdge.source).toBe('try1');
		expect(tryEdge.target).toBe('httpCall');
		// catch leaves the try body's own node, not the try/catch control node
		expect(catchEdge.source).toBe('httpCall');
		expect(catchEdge.target).toBe('setCatch');
		expect(continueEdge).toBeDefined();
		expect(continueEdge.source).toBe('httpCall');
		expect(continueEdge.target).toBe('end');
		expect(continueEdge.label).toBeUndefined();

		const hidden = computeHiddenRealEdgeIds(nodes, edges);
		expect(hidden.has('e-try1-end')).toBe(true);
	});

	it('falls back to the control node for catch when the try body is empty', () => {
		const tryNode: Node = {
			id: 'try1',
			type: 'try',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		const catchKey = catchScopeKey(ROOT_SCOPE_ID, 'try1');
		const setCatch: Node = {
			id: 'setCatch',
			type: 'set',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: catchKey }
		};
		const synthetic = computeLiveSyntheticEdges([tryNode, setCatch], []);
		const catchEdge = synthetic.find((e) => e.label === 'catch')!;
		expect(catchEdge.source).toBe('try1');
	});

	it('does not hide or redirect anything when the try node has no outgoing main edge (last in chain, no End node present)', () => {
		const tryKey = tryScopeKey(ROOT_SCOPE_ID, 'try1');
		const tryNode: Node = {
			id: 'try1',
			type: 'try',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		const httpCall: Node = {
			id: 'httpCall',
			type: 'call',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: tryKey }
		};
		const nodes = [tryNode, httpCall];
		const synthetic = computeLiveSyntheticEdges(nodes, []);
		expect(synthetic.some((e) => (e.data as { kind?: string })?.kind === 'continue')).toBe(false);
		expect(computeHiddenRealEdgeIds(nodes, []).size).toBe(0);
	});

	it('never redirects for/fork continuation edges — they are genuine pass-throughs/fan-outs, not fallback paths', () => {
		const forId = 'for1';
		const bodyKey = forScopeKey(ROOT_SCOPE_ID, forId);
		const forNode: Node = {
			id: forId,
			type: 'for',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		const step: Node = {
			id: 'step',
			type: 'set',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: bodyKey }
		};
		const after: Node = {
			id: 'after',
			type: 'set',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		const nodes = [forNode, step, after];
		const realNextEdge: Edge = { id: 'e-for-after', source: forId, target: 'after' };
		const edges = [realNextEdge];

		const synthetic = computeLiveSyntheticEdges(nodes, edges);
		expect(synthetic.some((e) => (e.data as { kind?: string })?.kind === 'continue')).toBe(false);
		expect(computeHiddenRealEdgeIds(nodes, edges).size).toBe(0);
	});
});

describe('collectDescendantScopeKeysForNode / collectDescendantScopeKeysForLaneKey', () => {
	it("collects a try node's two lane keys", () => {
		const tryKey = tryScopeKey(ROOT_SCOPE_ID, 'try1');
		const catchKey = catchScopeKey(ROOT_SCOPE_ID, 'try1');
		const tryNode: Node = { id: 'try1', type: 'try', position: { x: 0, y: 0 }, data: {} };
		const keys = collectDescendantScopeKeysForNode(tryNode, ROOT_SCOPE_ID, [tryNode]);
		expect(keys.sort()).toEqual([catchKey, tryKey].sort());
	});

	it('recurses through a fork branch containing a nested for-loop', () => {
		const forkId = 'fork1';
		const forId = 'for1';
		const branchKey = forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b1');
		const nestedBodyKey = forScopeKey(branchKey, forId);
		const forkNode: Node = {
			id: forkId,
			type: 'fork',
			position: { x: 0, y: 0 },
			data: { branches: [{ id: 'b1', name: 'loopBranch' }] }
		};
		const nestedForNode: Node = {
			id: forId,
			type: 'for',
			position: { x: 0, y: 0 },
			data: { [OWNER_SCOPE_TAG]: branchKey }
		};
		const keys = collectDescendantScopeKeysForNode(forkNode, ROOT_SCOPE_ID, [
			forkNode,
			nestedForNode
		]);
		expect(keys.sort()).toEqual([branchKey, nestedBodyKey].sort());
	});

	it('scopes to just one branch when removing a single fork branch, not its siblings', () => {
		const forkId = 'fork1';
		const branchAKey = forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'a');
		const branchBKey = forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b');
		const keys = collectDescendantScopeKeysForLaneKey(branchAKey, []);
		expect(keys).toEqual([branchAKey]);
		expect(keys).not.toContain(branchBKey);
	});
});

describe('computeTerminalEdges', () => {
	function endNode(): Node {
		return { id: 'end', type: 'end', position: { x: 0, y: 0 }, data: {} };
	}

	it('connects every dead-end node (no outgoing edge) to the end node', () => {
		const forkId = 'fork1';
		const branchAKey = forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'a');
		const branchBKey = forkBranchScopeKey(ROOT_SCOPE_ID, forkId, 'b');
		const branchA = node('callNurse', 'call', { [OWNER_SCOPE_TAG]: branchAKey });
		const branchB = node('callDoctor', 'call', { [OWNER_SCOPE_TAG]: branchBKey });
		const nodes = [endNode(), branchA, branchB];

		const terminal = computeTerminalEdges(nodes, []);
		expect(terminal).toHaveLength(2);
		expect(terminal.every((e) => e.target === 'end')).toBe(true);
		expect(terminal.map((e) => e.source).sort()).toEqual(['callDoctor', 'callNurse']);
		expect(terminal.every((e) => e.deletable === false && e.selectable === false)).toBe(true);
	});

	it('does not add a terminal edge for a node that already has a real outgoing edge', () => {
		const lastRealNode = node('notify', 'set');
		const nodes = [endNode(), lastRealNode];
		const edges: Edge[] = [{ id: 'e-notify-end', source: 'notify', target: 'end' }];

		const terminal = computeTerminalEdges(nodes, edges);
		expect(terminal).toHaveLength(0);
	});

	it('does not add a terminal edge for a node already covered by a synthetic edge (e.g. a try-lane redirect source)', () => {
		const httpCall = node('httpCall', 'call');
		const nodes = [endNode(), httpCall];
		// simulates computeLiveSyntheticEdges already having produced a continuation edge from httpCall
		const alreadySynthetic: Edge[] = [
			{ id: 'continue-edge-try1', source: 'httpCall', target: 'end' }
		];

		const terminal = computeTerminalEdges(nodes, alreadySynthetic);
		expect(terminal).toHaveLength(0);
	});

	it('returns nothing when there is no end node in scope', () => {
		const nodes = [node('orphan', 'set')];
		expect(computeTerminalEdges(nodes, [])).toHaveLength(0);
	});
});
