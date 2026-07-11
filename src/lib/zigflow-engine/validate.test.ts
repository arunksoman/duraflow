import { describe, it, expect } from 'vitest';
import { validateZigflowDocument } from './validate';

describe('validateZigflowDocument', () => {
	it('accepts a minimal valid document', () => {
		const doc = {
			document: {
				dsl: '1.0.0',
				taskQueue: 'zigflow',
				workflowType: 'hello-world',
				version: '0.1.0'
			},
			do: [{ sayHello: { set: { message: 'hello' } } }]
		};
		const result = validateZigflowDocument(doc);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('accepts a document exercising every task type with nested bodies', () => {
		const doc = {
			document: {
				dsl: '1.0.0',
				taskQueue: 'zigflow',
				workflowType: 'full-example',
				version: '0.1.0'
			},
			do: [
				{ setup: { set: { id: '${ uuid }' } } },
				{
					getUser: {
						call: 'http',
						with: { method: 'get', endpoint: 'https://example.com/users/1' }
					}
				},
				{
					guarded: {
						if: '${ $data.id != null }',
						set: { checked: true }
					}
				},
				{
					routeOrder: {
						switch: [
							{ electronic: { when: "${ $input.type == 'electronic' }", then: 'continue' } },
							{ default: { then: 'end' } }
						]
					}
				},
				{
					loop: {
						for: { each: 'item', at: 'index', in: '${ $input.items }' },
						do: [{ step: { set: { value: '${ $data.item }' } } }]
					}
				},
				{
					parallel: {
						fork: {
							compete: false,
							branches: [
								{ branchA: { do: [{ a1: { set: { x: 1 } } }] } },
								{ branchB: { do: [{ b1: { set: { y: 2 } } }] } }
							]
						}
					}
				},
				{
					guarded2: {
						try: [
							{ risky: { raise: { error: { type: 'https://example.com/errors/x', status: 400 } } } }
						],
						catch: { as: 'error', do: [{ handle: { set: { message: '${ $data.error }' } } }] }
					}
				},
				{ pause: { wait: { seconds: 5 } } },
				{
					listenOnce: {
						listen: { to: { one: { with: { id: 'approve', type: 'signal' } } } }
					}
				},
				{
					runScript: {
						run: { script: { language: 'js', code: 'console.log(1)' } }
					}
				},
				{
					runContainer: {
						run: { container: { image: 'alpine', pullPolicy: 'ifNotPresent' } }
					}
				},
				{
					childFlow: {
						run: { workflow: { type: 'child-workflow' } }
					}
				}
			]
		};
		const result = validateZigflowDocument(doc);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it('rejects a document missing required document fields', () => {
		const result = validateZigflowDocument({ document: { dsl: '1.0.0' }, do: [] });
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('rejects an uppercase pullPolicy value', () => {
		const doc = {
			document: { dsl: '1.0.0', taskQueue: 'zigflow', workflowType: 'x', version: '0.1.0' },
			do: [{ runContainer: { run: { container: { image: 'alpine', pullPolicy: 'Always' } } } }]
		};
		const result = validateZigflowDocument(doc);
		expect(result.valid).toBe(false);
	});

	it('rejects an unknown top-level task keyword (e.g. the removed "task"/"if" node types)', () => {
		const doc = {
			document: { dsl: '1.0.0', taskQueue: 'zigflow', workflowType: 'x', version: '0.1.0' },
			do: [{ oops: { task: { method: 'get', endpoint: 'https://example.com' } } }]
		};
		const result = validateZigflowDocument(doc);
		expect(result.valid).toBe(false);
	});
});
