import { describe, it, expect } from 'vitest';
import {
	buildCronPreset,
	isValidCronExpression,
	joinCron,
	parseCronPreset,
	splitCron,
	type CronPreset
} from './cron';

describe('splitCron / joinCron', () => {
	it('splits exactly five whitespace-separated fields', () => {
		expect(splitCron('  0   9 * * 1-5 ')).toEqual({
			minute: '0',
			hour: '9',
			dayOfMonth: '*',
			month: '*',
			dayOfWeek: '1-5'
		});
	});

	it('rejects anything that is not five fields', () => {
		expect(splitCron('0 9 * *')).toBeNull();
		expect(splitCron('0 0 0 9 * * *')).toBeNull();
		expect(splitCron('')).toBeNull();
	});

	it('round-trips through joinCron', () => {
		const expression = '30 2 1 * *';
		expect(joinCron(splitCron(expression)!)).toBe(expression);
	});
});

describe('parseCronPreset', () => {
	const cases: [string, CronPreset][] = [
		['* * * * *', { kind: 'everyMinute' }],
		['*/15 * * * *', { kind: 'everyNMinutes', minutes: 15 }],
		['0 * * * *', { kind: 'hourly', minute: 0 }],
		['45 * * * *', { kind: 'hourly', minute: 45 }],
		['15 */6 * * *', { kind: 'everyNHours', hours: 6, minute: 15 }],
		['0 0 * * *', { kind: 'daily', hour: 0, minute: 0 }],
		['30 9 * * *', { kind: 'daily', hour: 9, minute: 30 }],
		['0 9 * * 1,3,5', { kind: 'weekly', weekdays: [1, 3, 5], hour: 9, minute: 0 }],
		['0 3 1 * *', { kind: 'monthly', dayOfMonth: 1, hour: 3, minute: 0 }]
	];

	for (const [expression, preset] of cases) {
		it(`reads ${expression}`, () => {
			expect(parseCronPreset(expression)).toEqual(preset);
		});
	}

	it('normalizes an unsorted, duplicated-free weekday list', () => {
		expect(parseCronPreset('0 9 * * 5,1')).toEqual({
			kind: 'weekly',
			weekdays: [1, 5],
			hour: 9,
			minute: 0
		});
	});

	it('falls back to custom rather than guessing', () => {
		// A constrained month, a day-of-month/day-of-week OR, ranges, and out-of-range values are
		// all perfectly valid cron that the visual editor has no control for.
		expect(parseCronPreset('0 0 1 1 *')).toEqual({ kind: 'custom' });
		expect(parseCronPreset('0 0 1 * 1')).toEqual({ kind: 'custom' });
		expect(parseCronPreset('0 9 * * 1-5')).toEqual({ kind: 'custom' });
		expect(parseCronPreset('0 99 * * *')).toEqual({ kind: 'custom' });
		expect(parseCronPreset('not a cron')).toEqual({ kind: 'custom' });
	});

	it('duplicate weekdays are not silently collapsed', () => {
		expect(parseCronPreset('0 9 * * 1,1')).toEqual({ kind: 'custom' });
	});
});

describe('buildCronPreset', () => {
	it('is the inverse of parseCronPreset for every recognised shape', () => {
		const expressions = [
			'* * * * *',
			'*/15 * * * *',
			'45 * * * *',
			'15 */6 * * *',
			'30 9 * * *',
			'0 9 * * 1,3,5',
			'0 3 1 * *'
		];
		for (const expression of expressions) {
			expect(buildCronPreset(parseCronPreset(expression))).toBe(expression);
		}
	});

	it('sorts weekdays so the expression is stable regardless of click order', () => {
		expect(buildCronPreset({ kind: 'weekly', weekdays: [5, 0, 2], hour: 8, minute: 5 })).toBe(
			'5 8 * * 0,2,5'
		);
	});
});

describe('isValidCronExpression', () => {
	it('accepts lists, ranges, steps and wildcards', () => {
		for (const expression of [
			'* * * * *',
			'0,30 9-17 * * 1-5',
			'*/5 */2 1,15 */3 *',
			'0 0 31 12 7'
		]) {
			expect(isValidCronExpression(expression)).toBe(true);
		}
	});

	it('rejects out-of-range values, bad steps and wrong field counts', () => {
		for (const expression of ['60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8']) {
			expect(isValidCronExpression(expression)).toBe(false);
		}
		expect(isValidCronExpression('*/0 * * * *')).toBe(false);
		expect(isValidCronExpression('0 9 * *')).toBe(false);
		expect(isValidCronExpression('5-1 * * * *')).toBe(false);
	});
});
