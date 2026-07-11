import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { serializeZigflowDocument } from './serialize';
import { validateZigflowDocument } from './validate';
import type { ZigflowDocument } from './ast';

function header() {
	return { dsl: '1.0.0', taskQueue: 'zigflow', workflowType: 'example', version: '0.1.0' };
}

describe('serializeZigflowDocument', () => {
	it('emits a minimal set task and round-trips through the validator', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [{ hello: { set: { message: 'hi' } } }]
		};
		const yamlText = serializeZigflowDocument(doc);
		const parsed = parse(yamlText);
		expect(parsed.do[0].hello.set.message).toBe('hi');
		expect(validateZigflowDocument(parsed).valid).toBe(true);
	});

	it('fixes bug #1: emits lowercase pullPolicy', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					runContainer: {
						run: { container: { image: 'alpine', pullPolicy: 'ifNotPresent' } }
					}
				}
			]
		};
		const parsed = parse(serializeZigflowDocument(doc));
		expect(parsed.do[0].runContainer.run.container.pullPolicy).toBe('ifNotPresent');
		expect(validateZigflowDocument(parsed).valid).toBe(true);
	});

	it('fixes bug #2: emits raise.error.instance when present', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					bug: {
						raise: {
							error: {
								type: 'https://serverlessworkflow.io/spec/1.0.0/errors/validation',
								status: 400,
								instance: '/do/0/bug'
							}
						}
					}
				}
			]
		};
		const parsed = parse(serializeZigflowDocument(doc));
		expect(parsed.do[0].bug.raise.error.instance).toBe('/do/0/bug');
		expect(validateZigflowDocument(parsed).valid).toBe(true);
	});

	it('fixes bug #3: emits listen.to.one as a single object, not a list', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					approveListener: {
						listen: { to: { one: { with: { id: 'approve', type: 'signal' } } } }
					}
				}
			]
		};
		const yamlText = serializeZigflowDocument(doc);
		const parsed = parse(yamlText);
		expect(Array.isArray(parsed.do[0].approveListener.listen.to.one)).toBe(false);
		expect(parsed.do[0].approveListener.listen.to.one.with.id).toBe('approve');
		expect(validateZigflowDocument(parsed).valid).toBe(true);
	});

	it('still emits all/any as arrays for listen', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					waitAll: {
						listen: {
							to: {
								all: [
									{ with: { id: 'temperature', type: 'update' } },
									{ with: { id: 'bpm', type: 'update' } }
								]
							}
						}
					}
				}
			]
		};
		const parsed = parse(serializeZigflowDocument(doc));
		expect(Array.isArray(parsed.do[0].waitAll.listen.to.all)).toBe(true);
		expect(parsed.do[0].waitAll.listen.to.all).toHaveLength(2);
	});

	it('emits real nested for/fork/try bodies (no placeholders)', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
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
								{ callNurse: { do: [{ n1: { set: { x: 1 } } }] } },
								{ callDoctor: { do: [{ d1: { set: { y: 2 } } }] } }
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
		const parsed = parse(serializeZigflowDocument(doc));
		expect(parsed.do[0].loop.for.in).toBe('${ $input.items }');
		expect(parsed.do[0].loop.do[0].step.set.seen).toBe('${ $data.item }');
		expect(parsed.do[1].parallel.fork.branches[0].callNurse.do[0].n1.set.x).toBe(1);
		expect(parsed.do[1].parallel.fork.branches[1].callDoctor.do[0].d1.set.y).toBe(2);
		expect(parsed.do[2].guarded.catch.as).toBe('boom');
		expect(parsed.do[2].guarded.catch.do[0].handle.set.message).toBe('${ $data.boom }');
		expect(validateZigflowDocument(parsed).valid).toBe(true);
	});

	it('emits a shared `if` guard on an arbitrary task type (e.g. call), not just set', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					maybeCall: {
						if: '${ $input.enabled }',
						call: 'http',
						with: { method: 'get', endpoint: 'https://example.com' }
					}
				}
			]
		};
		const parsed = parse(serializeZigflowDocument(doc));
		expect(parsed.do[0].maybeCall.if).toBe('${ $input.enabled }');
		expect(parsed.do[0].maybeCall.call).toBe('http');
		expect(validateZigflowDocument(parsed).valid).toBe(true);
	});

	it('emits multiline run.script.code as a block-literal scalar', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					runScript: {
						run: { script: { language: 'js', code: 'const x = 1;\nconsole.log(x);' } }
					}
				}
			]
		};
		const yamlText = serializeZigflowDocument(doc);
		expect(yamlText).toContain('code: |');
		const parsed = parse(yamlText);
		expect(parsed.do[0].runScript.run.script.code).toBe('const x = 1;\nconsole.log(x);');
		expect(validateZigflowDocument(parsed).valid).toBe(true);
	});

	it('emits switch cases in order with a default case', () => {
		const doc: ZigflowDocument = {
			document: header(),
			do: [
				{
					routeOrder: {
						switch: [
							{
								electronic: {
									when: "${ $input.orderType == 'electronic' }",
									then: 'processElectronicOrder'
								}
							},
							{ default: { then: 'handleUnknownType' } }
						]
					}
				}
			]
		};
		const parsed = parse(serializeZigflowDocument(doc));
		expect(parsed.do[0].routeOrder.switch[0].electronic.then).toBe('processElectronicOrder');
		expect(parsed.do[0].routeOrder.switch[1].default.when).toBeUndefined();
		expect(validateZigflowDocument(parsed).valid).toBe(true);
	});
});
