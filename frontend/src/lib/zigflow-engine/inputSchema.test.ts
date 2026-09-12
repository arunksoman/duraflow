import { describe, it, expect } from 'vitest';
import { buildInputSkeleton, coerceInput, emptyValueFor, validateInput } from './inputSchema';
import { parseInputSchemaFromDsl } from './header';
import type { InputField } from '../types';

const fields: InputField[] = [
	{ name: 'userId', type: 'string', required: true },
	{ name: 'retries', type: 'number' },
	{ name: 'dryRun', type: 'boolean' },
	{ name: 'tags', type: 'array', itemsType: 'string' },
	{ name: 'options', type: 'object' }
];

describe('buildInputSkeleton', () => {
	it('gives every declared field an empty value of the right shape', () => {
		expect(buildInputSkeleton(fields)).toEqual({
			userId: '',
			retries: 0,
			dryRun: false,
			tags: [],
			options: {}
		});
	});

	it('skips fields with no name', () => {
		expect(buildInputSkeleton([{ name: '', type: 'string' }])).toEqual({});
	});
});

describe('validateInput', () => {
	it('reports a missing required field and lets optional blanks through', () => {
		const errors = validateInput(fields, buildInputSkeleton(fields));
		expect(errors).toEqual({ userId: 'Required.' });
	});

	it('reports the position of a wrongly-typed array item', () => {
		const errors = validateInput(fields, {
			userId: 'u1',
			tags: ['ok', 3]
		});
		expect(errors.tags).toBe('Item 2 must be a string.');
	});

	it('rejects an array where an object was declared', () => {
		const errors = validateInput(fields, { userId: 'u1', options: [] });
		expect(errors.options).toBe('Must be a JSON object.');
	});

	it('accepts a fully valid value', () => {
		expect(
			validateInput(fields, {
				userId: 'u1',
				retries: 3,
				dryRun: true,
				tags: ['a'],
				options: { deep: true }
			})
		).toEqual({});
	});
});

describe('coerceInput', () => {
	it('turns the strings an HTML form produces into the declared types', () => {
		expect(coerceInput(fields, { userId: 'u1', retries: '4', dryRun: 'true', tags: ['a'] })).toEqual(
			{ userId: 'u1', retries: 4, dryRun: true, tags: ['a'] }
		);
	});

	it('leaves an unconvertible value alone so validation can report it', () => {
		expect(coerceInput(fields, { retries: 'seven' }).retries).toBe('seven');
	});

	it('coerces array items to the declared item type', () => {
		const numeric: InputField[] = [{ name: 'ids', type: 'array', itemsType: 'number' }];
		expect(coerceInput(numeric, { ids: ['1', '2'] })).toEqual({ ids: [1, 2] });
	});
});

describe('emptyValueFor', () => {
	it('defaults an unknown-ish field to text', () => {
		expect(emptyValueFor({ name: 'x', type: 'string' })).toBe('');
	});
});

describe('parseInputSchemaFromDsl', () => {
	it('reads declared fields straight out of a stored DSL', () => {
		const dsl = `
document:
  dsl: 1.0.0
  taskQueue: zigflow
  workflowType: example
  version: 0.1.0
input:
  schema:
    format: json
    document:
      type: object
      required: [userId]
      properties:
        userId:
          type: string
          description: Who to fetch
        tags:
          type: array
          items:
            type: string
do:
  - fetch:
      call: http
      with:
        method: get
        endpoint: https://example.com
`;
		expect(parseInputSchemaFromDsl(dsl)).toEqual([
			{ name: 'userId', type: 'string', required: true, description: 'Who to fetch' },
			{ name: 'tags', type: 'array', itemsType: 'string' }
		]);
	});

	it('treats a blank or unparseable DSL as declaring no inputs', () => {
		expect(parseInputSchemaFromDsl('')).toEqual([]);
		expect(parseInputSchemaFromDsl('::: not yaml :::')).toEqual([]);
		expect(parseInputSchemaFromDsl('document:\n  dsl: 1.0.0\n')).toEqual([]);
	});
});
