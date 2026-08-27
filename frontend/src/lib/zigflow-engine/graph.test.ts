import { describe, it, expect } from 'vitest';
import { astToGraph, graphToAst } from './graph';
import type { WorkflowGraph } from './graph';
import { serializeZigflowDocument } from './serialize';
import { deserializeZigflowDocument } from './deserialize';
import {
	forScopeKey,
	forkBranchScopeKey,
	tryScopeKey,
	catchScopeKey,
	ROOT_SCOPE_ID
} from './scopeKey';
import type { ZigflowDocument } from './ast';

function header() {
	return { dsl: '1.0.0', taskQueue: 'zigflow', workflowType: 'example', version: '0.1.0' };
}

describe('astToGraph', () => {
	it('creates a root scope with a Start node followed by task nodes in order', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{ setup: { set: { id: '${ uuid }' } } },
				{ getUser: { call: 'http', with: { method: 'get', endpoint: 'https://example.com' } } }
			]
		};
		const { graph, header: hdr } = astToGraph(doc);
		expect(hdr.workflowType).toBe('example');
		const root = graph.scopes[ROOT_SCOPE_ID];
		expect(root.nodes.map((n) => n.type)).toEqual(['start', 'set', 'call', 'end']);
		expect(root.edges).toHaveLength(3);
	});

	it('always terminates the root scope with a non-deletable End node wired from the last task', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [{ setup: { set: { id: '${ uuid }' } } }]
		};
		const { graph } = astToGraph(doc);
		const root = graph.scopes[ROOT_SCOPE_ID];
		const endNode = root.nodes.find((n) => n.type === 'end')!;
		expect(endNode.deletable).toBe(false);
		const setNode = root.nodes.find((n) => n.type === 'set')!;
		expect(root.edges).toContainEqual(
			expect.objectContaining({ source: setNode.id, target: 'end' })
		);
	});

	it('wires Start straight to End for an empty task list', () => {
		const doc: ZigflowDocument = { document: header(), do: [] };
		const { graph } = astToGraph(doc);
		const root = graph.scopes[ROOT_SCOPE_ID];
		expect(root.nodes.map((n) => n.type)).toEqual(['start', 'end']);
		expect(root.edges).toContainEqual(expect.objectContaining({ source: 'start', target: 'end' }));
	});

	it('builds a nested scope for a For task body', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					loop: {
						for: { each: 'item', at: 'index', in: '${ $input.items }' },
						do: [{ step: { set: { seen: '${ $data.item }' } } }]
					}
				}
			]
		};
		const { graph } = astToGraph(doc);
		const forNode = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'for')!;
		const childScopeId = forScopeKey(ROOT_SCOPE_ID, forNode.id);
		expect(graph.scopes[childScopeId]).toBeDefined();
		expect(graph.scopes[childScopeId].nodes.map((n) => n.type)).toEqual(['set']);
	});

	it('builds one scope per Fork branch with stable branch ids', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					parallel: {
						fork: {
							branches: [
								{ callNurse: { do: [{ n1: { set: { x: 1 } } }] } },
								{
									callDoctor: {
										call: 'http',
										with: { method: 'get', endpoint: 'https://example.com' }
									}
								}
							]
						}
					}
				}
			]
		};
		const { graph } = astToGraph(doc);
		const forkNode = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'fork')!;
		const branches = forkNode.data?.branches as { id: string; name: string }[];
		expect(branches.map((b) => b.name)).toEqual(['callNurse', 'callDoctor']);
		const scope0 = graph.scopes[forkBranchScopeKey(ROOT_SCOPE_ID, forkNode.id, branches[0].id)];
		const scope1 = graph.scopes[forkBranchScopeKey(ROOT_SCOPE_ID, forkNode.id, branches[1].id)];
		expect(scope0.nodes.map((n) => n.type)).toEqual(['set']);
		// a branch whose task isn't itself a `do` (a bare `call`) becomes a single-item scope
		expect(scope1.nodes.map((n) => n.type)).toEqual(['call']);
	});

	it('builds separate try and catch scopes', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					guarded: {
						try: [{ risky: { set: { z: 1 } } }],
						catch: { as: 'boom', do: [{ handle: { set: { message: '${ $data.boom }' } } }] }
					}
				}
			]
		};
		const { graph } = astToGraph(doc);
		const tryNode = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'try')!;
		expect(tryNode.data?.catchAs).toBe('boom');
		expect(graph.scopes[tryScopeKey(ROOT_SCOPE_ID, tryNode.id)].nodes.map((n) => n.type)).toEqual([
			'set'
		]);
		expect(graph.scopes[catchScopeKey(ROOT_SCOPE_ID, tryNode.id)].nodes.map((n) => n.type)).toEqual(
			['set']
		);
	});

	it('maps run.workflow to a childWorkflow node, not a run node', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [{ callChild: { run: { workflow: { type: 'child-flow' } } } }]
		};
		const { graph } = astToGraph(doc);
		expect(graph.scopes[ROOT_SCOPE_ID].nodes.map((n) => n.type)).toEqual([
			'start',
			'childWorkflow',
			'end'
		]);
	});

	it('resolves a switch `then` task-name reference to the target node id', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					route: {
						switch: [
							{ electronic: { when: "${ $input.type == 'electronic' }", then: 'shipIt' } },
							{ default: { then: 'end' } }
						]
					}
				},
				{ shipIt: { set: { shipped: true } } }
			]
		};
		const { graph } = astToGraph(doc);
		const switchNode = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'switch')!;
		const shipItNode = graph.scopes[ROOT_SCOPE_ID].nodes.find(
			(n) => (n.data?.label as string) === 'shipIt'
		)!;
		const cases = switchNode.data?.cases as { then: string }[];
		expect(cases[0].then).toBe(shipItNode.id);
		expect(cases[1].then).toBe('end');
	});
	it('preserves a bare `for` fork branch instead of silently discarding its for/while wrapper', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					parallel: {
						fork: {
							branches: [
								{
									loopbranch: {
										for: { each: 'item', at: 'index', in: '${ $input.items }' },
										do: [{ step: { set: { seen: '${ $data.item }' } } }]
									}
								}
							]
						}
					}
				}
			]
		};
		const { graph, header: hdr } = astToGraph(doc);
		const forkNode = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'fork')!;
		const branches = forkNode.data?.branches as { id: string; name: string }[];
		const branchScope =
			graph.scopes[forkBranchScopeKey(ROOT_SCOPE_ID, forkNode.id, branches[0].id)];
		// Before the fix, `'do' in branchTask` also matched the `for` task (it carries its own `do`
		// body), so the branch silently collapsed to just its inner `set` node.
		expect(branchScope.nodes.map((n) => n.type)).toEqual(['for']);

		const rebuilt = graphToAst(graph, hdr);
		const forkTask = rebuilt.do[0].parallel as {
			fork: { branches: Record<string, unknown>[] };
		};
		const [branchName, branchTask] = Object.entries(forkTask.fork.branches[0])[0];
		expect(branchName).toBe('loopbranch');
		// emitted bare, matching the original shape — not re-wrapped as `{ do: [{ loopbranch: {...} }] }`
		expect(branchTask).toMatchObject({
			for: { each: 'item', at: 'index', in: '${ $input.items }' },
			do: [{ step: { set: { seen: '${ $data.item }' } } }]
		});
	});
});

describe('graphToAst', () => {
	it('round-trips a document through astToGraph -> graphToAst -> serialize -> deserialize', () => {
		const original: ZigflowDocument = {
			document: header(),
			do: [
				{ setup: { set: { id: '${ uuid }' } } },
				{
					loop: {
						for: { each: 'item', at: 'index', in: '${ $input.items }' },
						do: [{ step: { set: { seen: '${ $data.item }' } } }]
					}
				},
				{
					parallel: {
						fork: {
							branches: [
								{ branchA: { do: [{ a1: { set: { x: 1 } } }] } },
								{ branchB: { do: [{ b1: { set: { y: 2 } } }] } }
							]
						}
					}
				},
				{
					guarded: {
						try: [{ risky: { set: { z: 1 } } }],
						catch: { as: 'boom', do: [{ handle: { set: { message: '${ $data.boom }' } } }] }
					}
				}
			]
		};
		const { graph, header: hdr } = astToGraph(original);
		const rebuilt = graphToAst(graph, hdr);
		const yamlText = serializeZigflowDocument(rebuilt);
		const result = deserializeZigflowDocument(yamlText);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.document.document.workflowType).toBe('example');
		expect(result.document.do[0].setup).toMatchObject({ set: { id: '${ uuid }' } });
		const loop = result.document.do[1].loop as unknown as { for: { in: string }; do: unknown[] };
		expect(loop.for.in).toBe('${ $input.items }');
		expect(loop.do).toHaveLength(1);
	});

	it('emits a synthetic `init` set task from Start node variables', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [{ hello: { set: { message: 'hi' } } }]
		};
		const { graph, header: hdr } = astToGraph(doc);
		const startNode = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'start')!;
		startNode.data = {
			...startNode.data,
			variables: [{ key: 'orderId', value: '${ $input.orderId }' }]
		};
		const rebuilt = graphToAst(graph, hdr);
		expect(rebuilt.do[0]).toMatchObject({ init: { set: { orderId: '${ $input.orderId }' } } });
		expect(rebuilt.do[1]).toMatchObject({ hello: { set: { message: 'hi' } } });
	});

	it('emits a shared `if` guard from any node type, not just Set', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [{ setup: { set: { x: 1 } } }]
		};
		const { graph, header: hdr } = astToGraph(doc);
		const setNode = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'set')!;
		setNode.data = { ...setNode.data, if: '${ $input.enabled }' };
		const rebuilt = graphToAst(graph, hdr);
		expect((rebuilt.do[0].setup as { if?: string }).if).toBe('${ $input.enabled }');
	});

	it('round-trips document title/summary/tags/metadata instead of dropping them', () => {
		const doc: ZigflowDocument = {
			document: {
				dsl: '1.0.0',
				taskQueue: 'zigflow',
				workflowType: 'hello-world',
				version: '0.0.1',
				title: 'Hello World',
				summary: 'Hello world with Zigflow',
				metadata: { display: false }
			},
			do: [{ set: { set: { message: 'Hello from Ziggy' } } }]
		};
		const { graph, header: hdr } = astToGraph(doc);
		expect(hdr.title).toBe('Hello World');
		expect(hdr.summary).toBe('Hello world with Zigflow');
		expect(hdr.metadata).toEqual({ display: false });

		const rebuilt = graphToAst(graph, hdr);
		expect(rebuilt.document.title).toBe('Hello World');
		expect(rebuilt.document.summary).toBe('Hello world with Zigflow');
		expect(rebuilt.document.metadata).toEqual({ display: false });
	});

	it('round-trips an object-form `output.as` instead of dropping it', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					set: {
						output: { as: { data: '${ . }' } },
						set: { message: 'Hello from Ziggy' }
					}
				}
			]
		};
		const { graph, header: hdr } = astToGraph(doc);
		const setNode = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'set')!;
		// preserved as its JSON text rather than silently dropped
		expect(JSON.parse(setNode.data?.outputAs as string)).toEqual({ data: '${ . }' });

		const rebuilt = graphToAst(graph, hdr);
		expect(rebuilt.do[0].set).toMatchObject({
			output: { as: { data: '${ . }' } },
			set: { message: 'Hello from Ziggy' }
		});
	});

	it('round-trips a document-level `input.schema` instead of dropping it', () => {
		const doc: ZigflowDocument = {
			document: header(),
			input: {
				schema: {
					format: 'json',
					document: {
						type: 'object',
						required: ['userIds'],
						properties: {
							userIds: { type: 'array', items: { type: 'number' } },
							note: { type: 'string', description: 'optional note' }
						}
					}
				}
			},
			do: [
				{
					processBatch: {
						for: { each: 'user', at: 'index', in: '${ $input.userIds }' },
						do: [{ fetchUser: { set: { seen: '${ $data.user }' } } }]
					}
				}
			]
		};

		const { graph, header: hdr } = astToGraph(doc);
		expect(hdr.inputSchema).toEqual([
			{ name: 'userIds', type: 'array', required: true, itemsType: 'number' },
			{ name: 'note', type: 'string', description: 'optional note' }
		]);

		const rebuilt = graphToAst(graph, hdr);
		expect(rebuilt.input).toEqual(doc.input);

		const yamlText = serializeZigflowDocument(rebuilt);
		const result = deserializeZigflowDocument(yamlText);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.document.input).toEqual(doc.input);
	});

	it('omits the `input` key entirely when there is no input schema', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [{ setup: { set: { x: 1 } } }]
		};
		const { graph, header: hdr } = astToGraph(doc);
		expect(hdr.inputSchema).toEqual([]);

		const rebuilt = graphToAst(graph, hdr);
		expect(rebuilt.input).toBeUndefined();
		expect(serializeZigflowDocument(rebuilt)).not.toContain('input:');
	});

	it('round-trips per-task metadata and input/output/export schema instead of dropping them', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					charge: {
						metadata: { activityOptions: { retryPolicy: { maximumAttempts: 3 } } },
						input: {
							schema: {
								format: 'json',
								document: { type: 'object', properties: { amount: { type: 'number' } } }
							}
						},
						output: {
							as: '${ . }',
							schema: { format: 'json', document: { type: 'object' } }
						},
						export: {
							as: '${ $context }',
							schema: { format: 'json', document: { type: 'object' } }
						},
						set: { charged: 'yes' }
					}
				}
			]
		};
		const { graph, header: hdr } = astToGraph(doc);
		const rebuilt = graphToAst(graph, hdr);
		expect(rebuilt.do[0]).toEqual(doc.do[0]);
	});

	it('round-trips run.container/script/shell fields beyond image/pullPolicy/command/language/code', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					build: {
						run: {
							container: {
								image: 'alpine:latest',
								pullPolicy: 'always',
								name: 'builder',
								command: 'make build',
								volumes: { '/data': 'shared-volume' },
								environment: { CI: 'true' },
								arguments: ['--flag'],
								lifetime: { cleanup: 'always' }
							}
						}
					}
				},
				{
					runscript: {
						run: {
							script: {
								language: 'python',
								source: { endpoint: 'https://example.com/script.py' },
								environment: { PYTHONPATH: '/app' },
								arguments: ['--verbose']
							}
						}
					}
				},
				{
					runshell: {
						run: {
							shell: { command: 'echo hi', environment: { FOO: 'bar' }, arguments: ['a', 'b'] }
						}
					}
				}
			]
		};
		const { graph, header: hdr } = astToGraph(doc);
		const rebuilt = graphToAst(graph, hdr);
		expect(rebuilt.do[0]).toEqual(doc.do[0]);
		expect(rebuilt.do[1]).toEqual(doc.do[1]);
		expect(rebuilt.do[2]).toEqual(doc.do[2]);
	});

	it('falls back an unresolvable switch `then` to `continue` instead of emitting a raw node id', () => {
		const graph: WorkflowGraph = {
			scopes: {
				[ROOT_SCOPE_ID]: {
					nodes: [
						{
							id: 'node-switch',
							type: 'switch',
							position: { x: 0, y: 0 },
							data: {
								label: 'route',
								cases: [{ name: 'case1', condition: '', then: 'node-outside-this-scope' }]
							}
						}
					],
					edges: []
				}
			}
		};
		const rebuilt = graphToAst(graph, {
			workflowType: 'w',
			taskQueue: 'zigflow',
			version: '0.1.0'
		});
		const switchTask = rebuilt.do[0].route as { switch: Record<string, { then: string }>[] };
		const [, body] = Object.entries(switchTask.switch[0])[0];
		expect(body.then).toBe('continue');
	});
});
