import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/svelte';
import { layoutScopeRecursive, type LaneMap, type ScopeLane } from './layout';

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

function lane(
	key: string,
	nodes: Node[],
	edges: Edge[] = [],
	laneMap: LaneMap = new Map()
): ScopeLane {
	return { key, nodes, edges, laneMap };
}

function overlaps(
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number }
): boolean {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function assertNoOverlaps(nodes: Node[]) {
	const boxes = nodes.map(box);
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			expect(overlaps(boxes[i], boxes[j])).toBe(false);
		}
	}
}

const CARD_W = 176;
const CARD_H = 80;

function box(n: Node) {
	return { x: n.position.x, y: n.position.y, w: CARD_W, h: CARD_H };
}

describe('layoutScopeRecursive — 2-lane (try/catch shape)', () => {
	it('lays out a single container node with 2 lanes offset to the right, no overlaps', () => {
		const start = node('start', 'start');
		const tryNode = node('try1', 'try');
		const mainNodes = [start, tryNode];
		const mainEdges = chain(['start', 'try1']);

		const tryBodyA = node('httpCall');
		const catchBodyA = node('setCatch');
		const laneMap: LaneMap = new Map([
			['try1', [lane('try-lane', [tryBodyA]), lane('catch-lane', [catchBodyA])]]
		]);

		const bounds = layoutScopeRecursive(mainNodes, mainEdges, laneMap);

		expect(bounds.has('try-lane')).toBe(true);
		expect(bounds.has('catch-lane')).toBe(true);

		assertNoOverlaps([start, tryNode, tryBodyA, catchBodyA]);
		// lanes are offset to distinct x columns, right of the main chain
		expect(tryBodyA.position.x).toBeGreaterThan(tryNode.position.x);
		expect(catchBodyA.position.x).toBeGreaterThan(tryBodyA.position.x);
	});

	it('still reserves a placeholder bound for an empty lane (so the very first node dropped into it has something to hit-test against)', () => {
		const tryNode = node('try1', 'try');
		const laneMap: LaneMap = new Map([
			['try1', [lane('try-lane', [node('onlyTry')]), lane('catch-lane', [])]]
		]);
		const bounds = layoutScopeRecursive([tryNode], [], laneMap);
		expect(bounds.has('try-lane')).toBe(true);
		expect(bounds.has('catch-lane')).toBe(true);
		const catchBox = bounds.get('catch-lane')!;
		expect(catchBox.yEnd).toBeGreaterThan(catchBox.yStart);
	});

	it("places a second container node further down the chain below the first one's lane extent (no collision)", () => {
		const start = node('start', 'start');
		const try1 = node('try1', 'try');
		const try2 = node('try2', 'try');
		const mainNodes = [start, try1, try2];
		const mainEdges = chain(['start', 'try1', 'try2']);

		// try1 has a long try-lane (3 nodes); try2 has a short one (1 node)
		const a1 = node('a1');
		const a2 = node('a2');
		const a3 = node('a3');
		const c1 = node('c1');
		const b1 = node('b1');
		const c2 = node('c2');
		const laneMap: LaneMap = new Map([
			[
				'try1',
				[lane('try1-try', [a1, a2, a3], chain(['a1', 'a2', 'a3'])), lane('try1-catch', [c1])]
			],
			['try2', [lane('try2-try', [b1]), lane('try2-catch', [c2])]]
		]);

		const bounds = layoutScopeRecursive(mainNodes, mainEdges, laneMap);

		assertNoOverlaps([start, try1, try2, a1, a2, a3, c1, b1, c2]);

		// try2's own row (and therefore its lanes) must start at or below try1's lane extent
		const try1LaneBottom = bounds.get('try1-try')!.yEnd;
		expect(try2.position.y).toBeGreaterThanOrEqual(try1LaneBottom);
	});
});

describe('layoutScopeRecursive — N-lane (fork shape)', () => {
	it('lays out 3 sibling lanes in distinct non-overlapping columns, row cursor advances past the tallest', () => {
		const start = node('start', 'start');
		const forkNode = node('fork1', 'fork');
		const mainNodes = [start, forkNode];
		const mainEdges = chain(['start', 'fork1']);

		const b1 = node('callNurse');
		const m1 = node('wait1');
		const m2 = node('wait2');
		const b3 = node('callDoctor');
		const laneMap: LaneMap = new Map([
			[
				'fork1',
				[
					lane('branch-a', [b1]),
					lane('branch-b', [m1, m2], chain(['wait1', 'wait2'])),
					lane('branch-c', [b3])
				]
			]
		]);

		const bounds = layoutScopeRecursive(mainNodes, mainEdges, laneMap);

		expect(['branch-a', 'branch-b', 'branch-c'].every((k) => bounds.has(k))).toBe(true);
		assertNoOverlaps([start, forkNode, b1, m1, m2, b3]);
		expect(b1.position.x).toBeLessThan(m1.position.x);
		expect(m1.position.x).toBeLessThan(b3.position.x);
		// all 3 branches start on the same row, right after the fork node
		expect(b1.position.y).toBe(m1.position.y);
		expect(m1.position.y).toBe(b3.position.y);
	});

	it('widens correctly when branch count grows from 2 to 4, still with no overlaps', () => {
		const forkNode = node('fork1', 'fork');
		const branches = ['b1', 'b2', 'b3', 'b4'].map((id) => node(id));
		const laneMap: LaneMap = new Map([['fork1', branches.map((b) => lane(`branch-${b.id}`, [b]))]]);

		const bounds = layoutScopeRecursive([forkNode], [], laneMap);
		expect(bounds.size).toBe(4);
		assertNoOverlaps([forkNode, ...branches]);
		const xs = branches.map((b) => b.position.x);
		expect(new Set(xs).size).toBe(4); // 4 distinct columns
	});
});

describe('layoutScopeRecursive — recursive nesting', () => {
	it('lays out a fork branch that itself contains a nested for-loop with no overlap against sibling branches', () => {
		const forkNode = node('fork1', 'fork');
		const forNode = node('for1', 'for');
		const branchA = node('branchA');
		const branchC = node('branchC');

		// Branch B's own chain is just the nested `for` node; the for's body is its own nested lane.
		const forBody1 = node('step1');
		const forBody2 = node('step2');
		const nestedLaneMap: LaneMap = new Map([
			['for1', [lane('for1-body', [forBody1, forBody2], chain(['step1', 'step2']))]]
		]);

		const laneMap: LaneMap = new Map([
			[
				'fork1',
				[
					lane('branch-a', [branchA]),
					lane('branch-b', [forNode], [], nestedLaneMap),
					lane('branch-c', [branchC])
				]
			]
		]);

		const bounds = layoutScopeRecursive([forkNode], [], laneMap);

		expect(bounds.has('branch-a')).toBe(true);
		expect(bounds.has('branch-b')).toBe(true);
		expect(bounds.has('branch-c')).toBe(true);
		expect(bounds.has('for1-body')).toBe(true);

		// The critical regression case: branch-b is widened by its nested for-loop's body lane, so
		// branch-c (the next sibling lane over) must start further right than a flat, non-recursive
		// column spacing would place it — and none of the rendered boxes may overlap.
		assertNoOverlaps([forkNode, branchA, forNode, forBody1, forBody2, branchC]);
		expect(branchC.position.x).toBeGreaterThan(forBody1.position.x);
	});
});
