import { describe, expect, it } from 'vitest';
import { parseCondition, serializeCondition, type ConditionClause } from './condition';

function roundTrip(value: string): string {
	return serializeCondition(parseCondition(value));
}

describe('parseCondition', () => {
	it('is empty for an empty value', () => {
		expect(parseCondition('')).toEqual([]);
		expect(serializeCondition([])).toBe('');
	});

	it('parses comparisons with typed right operands', () => {
		expect(
			parseCondition('${ .status == "ok" and $data.count >= -2 or $input.flag != null }')
		).toEqual([
			{ left: '.status', op: '==', right: { kind: 'string', value: 'ok' }, join: 'and' },
			{ left: '$data.count', op: '>=', right: { kind: 'number', value: '-2' }, join: 'or' },
			{ left: '$input.flag', op: '!=', right: { kind: 'null', value: '' }, join: 'and' }
		]);
	});

	it('keeps a variable right operand as jq', () => {
		expect(parseCondition('${ $data.a < $input.max }')[0].right).toEqual({
			kind: 'expr',
			value: '$input.max'
		});
	});

	it('parses function operators and negation', () => {
		expect(parseCondition('${ ($data.name | startswith("x")) and ($data.done | not) }')).toEqual([
			{ left: '$data.name', op: 'startswith', right: { kind: 'string', value: 'x' }, join: 'and' },
			{ left: '$data.done', op: 'falsy', right: { kind: 'null', value: '' }, join: 'and' }
		]);
		// Legacy unparenthesized single-clause form.
		expect(parseCondition('${ $data.done | not }')[0].op).toBe('falsy');
	});

	it('treats an operand with no operator as truthy', () => {
		expect(parseCondition('${ $data.enabled }')).toEqual([
			{ left: '$data.enabled', op: 'truthy', right: { kind: 'null', value: '' }, join: 'and' }
		]);
	});

	it('does not split inside strings or brackets', () => {
		const clauses = parseCondition('${ .msg == "rock and roll" and (.a or .b) }');
		expect(clauses).toHaveLength(2);
		expect(clauses[0].right).toEqual({ kind: 'string', value: 'rock and roll' });
		expect(clauses[1]).toMatchObject({ left: '(.a or .b)', op: 'truthy' });
	});

	it('unwraps a piped left operand', () => {
		expect(parseCondition('${ ($data.items | length) > 3 }')[0]).toMatchObject({
			left: '$data.items | length',
			op: '>',
			right: { kind: 'number', value: '3' }
		});
	});

	it.each([
		'${ .status == "ok" }',
		'${ $data.count >= -2 or $input.flag != null }',
		'${ ($data.items | length) > 3 and $data.enabled }',
		'${ ($data.name | contains("a\\"b")) }',
		'${ ($data.done | not) }',
		'${ .msg == "rock and roll" and (.a or .b) }',
		'${ $data.a < $input.max }'
	])('round-trips %s unchanged', (value) => {
		expect(roundTrip(value)).toBe(value);
	});
});

describe('serializeCondition', () => {
	it('skips incomplete clauses', () => {
		const clauses: ConditionClause[] = [
			{ left: '', op: '==', right: { kind: 'string', value: 'x' }, join: 'and' },
			{ left: '$data.a', op: '==', right: { kind: 'expr', value: '' }, join: 'and' },
			{ left: '$data.b', op: 'truthy', right: { kind: 'null', value: '' }, join: 'and' }
		];
		expect(serializeCondition(clauses)).toBe('${ $data.b }');
	});

	it('parenthesizes piped operands so and/or keep their meaning', () => {
		expect(
			serializeCondition([
				{
					left: '$data.items | length',
					op: 'truthy',
					right: { kind: 'null', value: '' },
					join: 'or'
				},
				{ left: '$data.x', op: 'endswith', right: { kind: 'string', value: '.pdf' }, join: 'and' }
			])
		).toBe('${ ($data.items | length) or ($data.x | endswith(".pdf")) }');
	});
});
