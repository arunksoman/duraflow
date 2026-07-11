import { describe, it, expect } from 'vitest';
import { deserializeZigflowDocument } from './deserialize';
import { serializeZigflowDocument } from './serialize';
import { astToGraph, graphToAst } from './graph';
import type { ZigflowDocument } from './ast';

describe('deserializeZigflowDocument', () => {
	it('round-trips a document produced by the serializer', () => {
		const doc: ZigflowDocument = {
			document: { dsl: '1.0.0', taskQueue: 'zigflow', workflowType: 'roundtrip', version: '0.1.0' },
			do: [
				{ setup: { set: { id: '${ uuid }' } } },
				{
					loop: {
						for: { each: 'item', at: 'index', in: '${ $input.items }' },
						do: [{ step: { set: { seen: '${ $data.item }' } } }]
					}
				}
			]
		};
		const yamlText = serializeZigflowDocument(doc);
		const result = deserializeZigflowDocument(yamlText);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.document.document.workflowType).toBe('roundtrip');
		expect(result.document.do[0].setup).toMatchObject({ set: { id: '${ uuid }' } });
		const loopTask = result.document.do[1].loop as unknown as {
			for: { each: string; at: string; in: string };
		};
		expect(loopTask.for).toEqual({ each: 'item', at: 'index', in: '${ $input.items }' });
	});

	it('applies schema-declared defaults when omitted from the source YAML', () => {
		const yamlText = `
document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: defaults-example
  version: 0.1.0
do:
  - loop:
      for:
        in: \${ $input.items }
      do:
        - step:
            set:
              x: 1
  - guarded:
      try:
        - risky:
            set:
              y: 1
      catch:
        do:
          - handle:
              set:
                z: 1
`;
		const result = deserializeZigflowDocument(yamlText);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const loop = result.document.do[0].loop as unknown as { for: { each: string; at: string } };
		expect(loop.for.each).toBe('item');
		expect(loop.for.at).toBe('index');
		const guarded = result.document.do[1].guarded as unknown as { catch: { as: string } };
		expect(guarded.catch.as).toBe('error');
	});

	it('returns structured errors with source ranges for invalid YAML', () => {
		const yamlText = `
document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: bad-example
  version: 0.1.0
do:
  - runContainer:
      run:
        container:
          image: alpine
          pullPolicy: Always
`;
		const result = deserializeZigflowDocument(yamlText);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0].range).toBeDefined();
	});

	it('returns a parse error (no crash) for malformed YAML syntax', () => {
		const result = deserializeZigflowDocument('document: [this is: not valid');
		expect(result.ok).toBe(false);
	});

	it('rejects a document missing required top-level fields', () => {
		const result = deserializeZigflowDocument('document:\n  dsl: 1.0.0\ndo: []');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('round-trips document title/summary/metadata and an object-form output.as through the full DSL -> canvas -> DSL pipeline', () => {
		const yamlText = `
document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: hello-world
  version: 0.0.1
  title: Hello World
  summary: Hello world with Zigflow
  metadata:
    display: false
do:
  - set:
      output:
        as:
          data: \${ . }
      set:
        message: Hello from Ziggy
`;
		const parsed = deserializeZigflowDocument(yamlText);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const { graph, header } = astToGraph(parsed.document);
		const rebuilt = graphToAst(graph, header);

		expect(rebuilt.document.title).toBe('Hello World');
		expect(rebuilt.document.summary).toBe('Hello world with Zigflow');
		expect(rebuilt.document.metadata).toEqual({ display: false });
		expect(rebuilt.do[0].set).toMatchObject({
			output: { as: { data: '${ . }' } },
			set: { message: 'Hello from Ziggy' }
		});
	});
});
