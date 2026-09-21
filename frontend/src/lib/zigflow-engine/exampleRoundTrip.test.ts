import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	astToGraph,
	graphToAst,
	namedWorkflowScopes,
	namedWorkflowStart,
	type ScopeGraph
} from './graph';
import { deserializeZigflowDocument } from './deserialize';
import { serializeZigflowDocument } from './serialize';
import { ROOT_SCOPE_ID } from './scopeKey';
import type { CaseEntry } from '../components/builder/builderConfig';

/**
 * `example/switch.yaml` is the hand-written document the switch model is measured against: every
 * shape a switch can take is in it (cases jumping at named workflows, and a second switch made only
 * of flow directives), and none of it was written by this engine. Its own comment says what the
 * handlers are — "These are declared as additional workflows" — and zigflow agrees: a `do:` that
 * follows another task is registered as a workflow of its own, drawn by `zigflow graph` as its own
 * subgraph with its own Start and End.
 */
function exampleDsl(): string {
	return readFileSync(
		fileURLToPath(new URL('../../../../example/switch.yaml', import.meta.url)),
		'utf8'
	);
}

function label(scope: ScopeGraph, id: string): unknown {
	return scope.nodes.find((n) => n.id === id)?.data?.label;
}

function loadAndSave(text: string): string {
	const parsed = deserializeZigflowDocument(text);
	if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
	const { graph, header } = astToGraph(parsed.document);
	return serializeZigflowDocument(graphToAst(graph, header));
}

describe('example/switch.yaml', () => {
	it('loads the three handlers as named workflows the switch starts, not as steps of it', () => {
		const parsed = deserializeZigflowDocument(exampleDsl());
		if (!parsed.ok) throw new Error('fixture does not parse');
		const { graph } = astToGraph(parsed.document);
		const root = graph.scopes[ROOT_SCOPE_ID];

		// The primary workflow holds only its own steps: every `do:` after them is a workflow of its
		// own, which zigflow registers by name and never runs in place.
		expect(root.nodes.map((n) => [n.data?.label, n.type])).toEqual([
			['Start', 'start'],
			['wait', 'wait'],
			['switcher', 'switch'],
			['flowSwitcher', 'switch'],
			['wait', 'wait'],
			['End', 'end']
		]);
		expect(root.edges.map((e) => `${label(root, e.source)}->${label(root, e.target)}`)).toEqual([
			'Start->wait',
			'wait->switcher',
			'switcher->flowSwitcher',
			'flowSwitcher->wait',
			'wait->End'
		]);

		expect(
			namedWorkflowScopes(graph).map((k) => namedWorkflowStart(graph, k)?.data?.label)
		).toEqual(['processElectronicOrder', 'processPhysicalOrder', 'handleUnknownOrderType']);

		const switcher = root.nodes.find((n) => n.data?.label === 'switcher')!;
		const cases = switcher.data?.cases as CaseEntry[];
		expect(cases.map((c) => [c.name, c.routing, c.taskName])).toEqual([
			['electronic', 'task', 'processElectronicOrder'],
			['physical', 'task', 'processPhysicalOrder'],
			['default', 'task', 'handleUnknownOrderType']
		]);

		// each case resolves to that workflow's Start node, so renaming it keeps the case
		expect(cases.map((c) => c.targetNodeId)).toEqual(
			namedWorkflowScopes(graph).map((k) => namedWorkflowStart(graph, k)!.id)
		);
	});

	it('draws each named workflow like the primary one: its own Start, its steps, its own End', () => {
		const parsed = deserializeZigflowDocument(exampleDsl());
		if (!parsed.ok) throw new Error('fixture does not parse');
		const { graph } = astToGraph(parsed.document);
		const flow = (name: string) => {
			const key = namedWorkflowScopes(graph).find(
				(k) => namedWorkflowStart(graph, k)?.data?.label === name
			)!;
			const scope = graph.scopes[key];
			return {
				nodes: scope.nodes.map((n) => `${n.type}:${n.data?.label}`),
				edges: scope.edges.map((e) => `${label(scope, e.source)}->${label(scope, e.target)}`)
			};
		};
		expect(flow('processElectronicOrder')).toEqual({
			nodes: [
				'start:processElectronicOrder',
				'call:validatePayment',
				'call:fulfillOrder',
				'end:End'
			],
			edges: [
				'processElectronicOrder->validatePayment',
				'validatePayment->fulfillOrder',
				'fulfillOrder->End'
			]
		});
		expect(flow('processPhysicalOrder').nodes).toEqual([
			'start:processPhysicalOrder',
			'call:checkInventory',
			'call:packItems',
			'call:scheduleShipping',
			'end:End'
		]);
		expect(flow('handleUnknownOrderType').nodes).toEqual([
			'start:handleUnknownOrderType',
			'call:logWarning',
			'call:notifyAdmin',
			'end:End'
		]);
	});

	it('keeps the flow-directive switch exactly as written', () => {
		const parsed = deserializeZigflowDocument(exampleDsl());
		if (!parsed.ok) throw new Error('fixture does not parse');
		const { graph } = astToGraph(parsed.document);
		const flowSwitcher = graph.scopes[ROOT_SCOPE_ID].nodes.find(
			(n) => n.data?.label === 'flowSwitcher'
		)!;
		expect((flowSwitcher.data?.cases as CaseEntry[]).map((c) => [c.name, c.routing])).toEqual([
			['continue', 'continue'],
			['exit', 'exit'],
			['end', 'end'],
			['default', 'continue']
		]);
	});

	it('re-saves the document as written, inventing no convergence of its own', () => {
		const out = loadAndSave(exampleDsl());
		// task names survive verbatim — a re-save must not rename anything the author wrote
		expect(out).toContain('processElectronicOrder:');
		expect(out).toContain('validatePayment:');
		expect(out).toContain('then: processElectronicOrder');
		// The handlers are separate workflows: each runs to its own End, so nothing may be added to
		// route them back into the primary flow. (An earlier model wrote `then: flowSwitcher` here —
		// `zigflow graph` shows such a `then:` on a root `do:` task is ignored outright.)
		expect(out).not.toContain('then: flowSwitcher');
		expect(out).not.toContain('then: wait');
	});

	it('is stable: what the builder saves loads back and saves identically', () => {
		const once = loadAndSave(exampleDsl());
		expect(loadAndSave(once)).toBe(once);
	});
});
