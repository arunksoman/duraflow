import { describe, expect, it } from 'vitest';
import {
	parseExpression,
	parsePathText,
	parseRef,
	parseTransforms,
	pathToText,
	refToJq,
	serializeExpression,
	type ExprMode
} from './expression';

function roundTrip(value: string, mode: ExprMode = 'template'): string {
	return serializeExpression(parseExpression(value, mode), mode);
}

describe('parseRef / refToJq', () => {
	it('parses every source with nested paths', () => {
		expect(parseRef('$input.user.name')).toEqual({ source: 'input', path: ['user', 'name'] });
		expect(parseRef('$data.items[0].id')).toEqual({ source: 'data', path: ['items', 0, 'id'] });
		expect(parseRef('$context')).toEqual({ source: 'context', path: [] });
		expect(parseRef('$env.API_BASE')).toEqual({ source: 'env', path: ['API_BASE'] });
		expect(parseRef('$output["content-type"]')).toEqual({
			source: 'output',
			path: ['content-type']
		});
		expect(parseRef('.')).toEqual({ source: 'dot', path: [] });
		expect(parseRef('.status')).toEqual({ source: 'dot', path: ['status'] });
		expect(parseRef('.[0]')).toEqual({ source: 'dot', path: [0] });
	});

	it('rejects anything that is not a plain reference', () => {
		expect(parseRef('$foo.bar')).toBeNull();
		expect(parseRef('$data.x // 1')).toBeNull();
		expect(parseRef('$data.')).toBeNull();
		expect(parseRef('$data.x?')).toBeNull();
		expect(parseRef('foo')).toBeNull();
	});

	it('quotes keys that are not jq identifiers', () => {
		expect(refToJq('data', ['set-user', 'first name'])).toBe('$data["set-user"]["first name"]');
		expect(refToJq('dot', [])).toBe('.');
		expect(refToJq('dot', [0, 'id'])).toBe('.[0].id');
	});

	it('round-trips the human path text', () => {
		expect(pathToText(['user', 0, 'a-b'])).toBe('user[0]["a-b"]');
		expect(parsePathText('user[0]["a-b"]')).toEqual(['user', 0, 'a-b']);
		expect(parsePathText('')).toEqual([]);
		expect(parsePathText('user..name')).toBeNull();
	});

	it('parses pipe stages', () => {
		expect(parseTransforms('tostring | ascii_downcase')).toEqual(['tostring', 'ascii_downcase']);
		expect(parseTransforms('split(",") | .[0]')).toBeNull();
		expect(parseTransforms('')).toEqual([]);
	});
});

describe('parseExpression (template mode)', () => {
	it('keeps plain text as one literal', () => {
		expect(parseExpression('hello world')).toEqual([{ kind: 'literal', text: 'hello world' }]);
		expect(parseExpression('')).toEqual([]);
	});

	it('parses a nested variable with transforms', () => {
		expect(parseExpression('${ $input.user.name | ascii_downcase }')).toEqual([
			{ kind: 'var', source: 'input', path: ['user', 'name'], transforms: ['ascii_downcase'] }
		]);
	});

	it('parses a concatenation of text and variables', () => {
		expect(parseExpression('${ $env.API_BASE + "/users/" + ($data.id | tostring) }')).toEqual([
			{ kind: 'var', source: 'env', path: ['API_BASE'], transforms: [] },
			{ kind: 'literal', text: '/users/' },
			{ kind: 'var', source: 'data', path: ['id'], transforms: ['tostring'] }
		]);
	});

	it('keeps unrepresentable jq as a single raw token', () => {
		expect(parseExpression('${ { user: .user, id: $data.id } }')).toEqual([
			{ kind: 'raw', expr: '{ user: .user, id: $data.id }' }
		]);
		// `|` binds looser than `+`: this is NOT a chain of two operands.
		expect(parseExpression('${ "a" + $data.x | length }')).toEqual([
			{ kind: 'raw', expr: '"a" + $data.x | length' }
		]);
		expect(parseExpression('${ $data.x // "fallback" }')).toEqual([
			{ kind: 'raw', expr: '$data.x // "fallback"' }
		]);
	});

	it('does not mistake text with several ${ } pieces for one expression', () => {
		expect(parseExpression('${ a } and ${ b }')).toEqual([
			{ kind: 'literal', text: '${ a } and ${ b }' }
		]);
	});

	it.each([
		'${ $input.user.name }',
		'${ $data["set-user"].id }',
		'${ . }',
		'${ .items[0] }',
		'${ $env.API_BASE + "/users/" + ($data.id | tostring) }',
		'${ "say \\"hi\\" " + $input.name }',
		'${ { user: .user } }',
		'${ $data.x // "fallback" }',
		'${ "a" + $data.x | length }',
		'${ $data.items | map(.id) | join(",") }',
		'plain text',
		'https://example.com'
	])('round-trips %s unchanged', (value) => {
		expect(roundTrip(value)).toBe(value);
	});

	it('escapes quotes in literals added through the UI', () => {
		expect(
			serializeExpression([
				{ kind: 'literal', text: 'say "hi" ' },
				{ kind: 'var', source: 'input', path: ['name'], transforms: [] }
			])
		).toBe('${ "say \\"hi\\" " + $input.name }');
	});

	it('parenthesizes a transformed variable or raw piece inside a chain', () => {
		expect(
			serializeExpression([
				{ kind: 'var', source: 'data', path: ['n'], transforms: ['tostring'] },
				{ kind: 'raw', expr: '$data.a // "b"' }
			])
		).toBe('${ ($data.n | tostring) + ($data.a // "b") }');
		expect(roundTrip('${ ($data.n | tostring) + ($data.a // "b") }')).toBe(
			'${ ($data.n | tostring) + ($data.a // "b") }'
		);
	});
});

describe('parseExpression (jq mode)', () => {
	it('treats a bare string literal as a literal token', () => {
		expect(parseExpression('"ok"', 'jq')).toEqual([{ kind: 'literal', text: 'ok' }]);
		expect(serializeExpression([{ kind: 'literal', text: 'ok' }], 'jq')).toBe('"ok"');
	});

	it.each(['$input.count', '.status', '$data.items | length', '"a" + $data.b'])(
		'round-trips %s',
		(value) => {
			expect(roundTrip(value, 'jq')).toBe(value);
		}
	);
});
