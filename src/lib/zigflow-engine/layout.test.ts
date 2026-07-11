import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/svelte';
import { layoutScopeWithInlineTry, type InlineTryLane } from './layout';

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

function overlaps(
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number }
): boolean {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const CARD_W = 176;
const CARD_H = 80;

function box(n: Node) {
	return { x: n.position.x, y: n.position.y, w: CARD_W, h: CARD_H };
}

describe('layoutScopeWithInlineTry', () => {
	it('lays out a single try node with try/catch lanes offset to the right, no overlaps', () => {
		const start = node('start', 'start');
		const tryNode = node('try1', 'try');
		const mainNodes = [start, tryNode];
		const mainEdges = chain(['start', 'try1']);

		const tryBodyA = node('httpCall');
		const catchBodyA = node('setCatch');
		const lanes = new Map<string, InlineTryLane>([
			['try1', { tryNodes: [tryBodyA], tryEdges: [], catchNodes: [catchBodyA], catchEdges: [] }]
		]);

		const result = layoutScopeWithInlineTry(mainNodes, mainEdges, lanes);

		expect(result.tryBounds.has('try1')).toBe(true);
		expect(result.catchBounds.has('try1')).toBe(true);

		const allBoxes = [start, tryNode, tryBodyA, catchBodyA].map(box);
		for (let i = 0; i < allBoxes.length; i++) {
			for (let j = i + 1; j < allBoxes.length; j++) {
				expect(overlaps(allBoxes[i], allBoxes[j])).toBe(false);
			}
		}
		// try/catch lanes are offset to distinct x columns, right of the main chain
		expect(tryBodyA.position.x).toBeGreaterThan(tryNode.position.x);
		expect(catchBodyA.position.x).toBeGreaterThan(tryBodyA.position.x);
	});

	it('still reserves a placeholder bound for an empty lane (so the very first node dropped into it has something to hit-test against)', () => {
		const tryNode = node('try1', 'try');
		const lanes = new Map<string, InlineTryLane>([
			['try1', { tryNodes: [node('onlyTry')], tryEdges: [], catchNodes: [], catchEdges: [] }]
		]);
		const result = layoutScopeWithInlineTry([tryNode], [], lanes);
		expect(result.tryBounds.has('try1')).toBe(true);
		expect(result.catchBounds.has('try1')).toBe(true);
		const catchBox = result.catchBounds.get('try1')!;
		expect(catchBox.yEnd).toBeGreaterThan(catchBox.yStart);
	});

	it("places a second try node further down the chain below the first one's lane extent (no collision)", () => {
		const start = node('start', 'start');
		const try1 = node('try1', 'try');
		const try2 = node('try2', 'try');
		const mainNodes = [start, try1, try2];
		const mainEdges = chain(['start', 'try1', 'try2']);

		// try1 has a long try-lane (3 nodes); try2 has a short one (1 node)
		const lanes = new Map<string, InlineTryLane>([
			[
				'try1',
				{
					tryNodes: [node('a1'), node('a2'), node('a3')],
					tryEdges: chain(['a1', 'a2', 'a3']),
					catchNodes: [node('c1')],
					catchEdges: []
				}
			],
			['try2', { tryNodes: [node('b1')], tryEdges: [], catchNodes: [node('c2')], catchEdges: [] }]
		]);

		const result = layoutScopeWithInlineTry(mainNodes, mainEdges, lanes);

		const allNodes = [start, try1, try2, ...mainNodes]
			.concat(lanes.get('try1')!.tryNodes, lanes.get('try1')!.catchNodes)
			.concat(lanes.get('try2')!.tryNodes, lanes.get('try2')!.catchNodes);
		const uniqueNodes = Array.from(new Map(allNodes.map((n) => [n.id, n])).values());
		const boxes = uniqueNodes.map(box);
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				expect(overlaps(boxes[i], boxes[j])).toBe(false);
			}
		}

		// try2's own row (and therefore its lanes) must start at or below try1's lane extent
		const try1LaneBottom = result.tryBounds.get('try1')!.yEnd;
		expect(try2.position.y).toBeGreaterThanOrEqual(try1LaneBottom);
	});
});
