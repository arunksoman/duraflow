import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { astToGraph, graphToAst } from './graph';
import { deserializeZigflowDocument } from './deserialize';
import { serializeZigflowDocument } from './serialize';
import { ROOT_SCOPE_ID, workflowScopeKey } from './scopeKey';
import type { CaseEntry } from '../components/builder/builderConfig';

/**
 * `example/switch.yaml` is the hand-written document the switch model is measured against: every
 * shape a switch can take is in it (cases jumping at named workflows, and a second switch made only
 * of flow directives), and none of it was written by this engine. Its own comment says what the
 * handlers are — "These are declared as additional workflows" — and `zigflow graph` agrees: each
 * root-level `do:` task is drawn as its own subgraph with its own Start and End.
 */
function exampleDsl(): string {
	return readFileSync(
		fileURLToPath(new URL('../../../../example/switch.yaml', import.meta.url)),
		'utf8'
	);
}

function loadAndSave(text: string): string {
	const parsed = deserializeZigflowDocument(text);
	if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
	const { graph, header } = astToGraph(parsed.document);
	return serializeZigflowDocument(graphToAst(graph, header));
}

describe('example/switch.yaml', () => {
	it('loads the three handlers as named workflows the switch jumps at, not as branches of it', () => {
		const parsed = deserializeZigflowDocument(exampleDsl());
		if (!parsed.ok) throw new Error('fixture does not parse');
		const { graph } = astToGraph(parsed.document);
		const root = graph.scopes[ROOT_SCOPE_ID];

		expect(root.nodes.map((n) => [n.data?.label, n.type])).toEqual([
			['Start', 'start'],
			['wait', 'wait'],
			['switcher', 'switch'],
			['flowSwitcher', 'switch'],
			['wait', 'wait'],
			['processElectronicOrder', 'workflow'],
			['processPhysicalOrder', 'workflow'],
			['handleUnknownOrderType', 'workflow'],
			['End', 'end']
		]);

		// The primary workflow's chain skips the named workflows entirely — they run on their own.
		const chain = root.edges.map((e) => {
			const label = (id: string) => root.nodes.find((n) => n.id === id)?.data?.label;
			return `${label(e.source)}->${label(e.target)}`;
		});
		expect(chain).toEqual([
			'Start->wait',
			'wait->switcher',
			'switcher->flowSwitcher',
			'flowSwitcher->wait',
			'wait->End'
		]);

		const switcher = root.nodes.find((n) => n.data?.label === 'switcher')!;
		const cases = switcher.data?.cases as CaseEntry[];
		expect(cases.map((c) => [c.name, c.routing, c.taskName])).toEqual([
			['electronic', 'task', 'processElectronicOrder'],
			['physical', 'task', 'processPhysicalOrder'],
			['default', 'task', 'handleUnknownOrderType']
		]);

		// each case resolves to the workflow node itself, so renaming it keeps the jump
		const byLabel = (label: string) => root.nodes.find((n) => n.data?.label === label)!.id;
		expect(cases.map((c) => c.targetNodeId)).toEqual([
			byLabel('processElectronicOrder'),
			byLabel('processPhysicalOrder'),
			byLabel('handleUnknownOrderType')
		]);
	});

	it("puts each named workflow's steps in its own scope", () => {
		const parsed = deserializeZigflowDocument(exampleDsl());
		if (!parsed.ok) throw new Error('fixture does not parse');
		const { graph } = astToGraph(parsed.document);
		const body = (label: string) => {
			const node = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.data?.label === label)!;
			return graph.scopes[workflowScopeKey(node.id)].nodes.map((n) => n.data?.label);
		};
		expect(body('processElectronicOrder')).toEqual(['validatePayment', 'fulfillOrder']);
		expect(body('processPhysicalOrder')).toEqual([
			'checkInventory',
			'packItems',
			'scheduleShipping'
		]);
		expect(body('handleUnknownOrderType')).toEqual(['logWarning', 'notifyAdmin']);
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
