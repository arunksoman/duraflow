import { describe, expect, it } from 'vitest';
import {
	parseExportAs,
	parseOutputAs,
	serializeExportMerge,
	serializeOutputFields
} from './dataFlow';

describe('output.as', () => {
	it('recognises the default, field-object and custom shapes', () => {
		expect(parseOutputAs('')).toEqual({ mode: 'default', fields: [] });
		expect(parseOutputAs('{"user":"${ .user }","ok":"yes"}')).toEqual({
			mode: 'fields',
			fields: [
				{ key: 'user', value: '${ .user }' },
				{ key: 'ok', value: 'yes' }
			]
		});
		expect(parseOutputAs('${ { user: .user } }').mode).toBe('custom');
		expect(parseOutputAs('{"n":1}').mode).toBe('custom');
	});

	it('serializes fields, dropping rows without a key', () => {
		expect(
			serializeOutputFields([
				{ key: 'user', value: '${ .user }' },
				{ key: ' ', value: 'ignored' }
			])
		).toBe('{"user":"${ .user }"}');
		expect(serializeOutputFields([])).toBe('');
	});
});

describe('export.as', () => {
	it('recognises a context merge', () => {
		expect(parseExportAs('${ $context + { user: .user, "odd-key": ($data.a | length) } }')).toEqual(
			{
				mode: 'merge',
				fields: [
					{ key: 'user', value: '.user' },
					{ key: 'odd-key', value: '$data.a | length' }
				]
			}
		);
		expect(parseExportAs('')).toEqual({ mode: 'none', fields: [] });
		expect(parseExportAs('${ . }').mode).toBe('custom');
		expect(parseExportAs('${ $context + {a: 1} + {b: 2} }').mode).toBe('custom');
	});

	it('round-trips a merge', () => {
		const value = '${ $context + { user: .user, "odd-key": ($data.a | length) } }';
		expect(serializeExportMerge(parseExportAs(value).fields)).toBe(value);
	});

	it('serializes nothing without a complete row', () => {
		expect(serializeExportMerge([{ key: 'a', value: '' }])).toBe('');
	});
});
