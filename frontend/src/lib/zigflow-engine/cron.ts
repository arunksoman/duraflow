/**
 * Standard 5-field cron (minute hour day-of-month month day-of-week), the dialect Temporal accepts
 * and therefore the only one this builder emits. Everything here is pure string work so the visual
 * cron editor can round-trip an expression without owning any of the parsing rules:
 * `parseCronPreset` recognises the handful of shapes the editor can draw, and `buildCronPreset` is
 * its exact inverse. Anything it can't recognise degrades to `{ kind: 'custom' }`, which the editor
 * renders as five raw fields rather than guessing.
 */

export const CRON_FIELD_COUNT = 5;

export type CronPreset =
	| { kind: 'everyMinute' }
	| { kind: 'everyNMinutes'; minutes: number }
	| { kind: 'everyNHours'; hours: number; minute: number }
	| { kind: 'hourly'; minute: number }
	| { kind: 'daily'; hour: number; minute: number }
	/** `weekdays` is a sorted list of 0–6, Sunday = 0 (cron's own numbering). */
	| { kind: 'weekly'; weekdays: number[]; hour: number; minute: number }
	| { kind: 'monthly'; dayOfMonth: number; hour: number; minute: number }
	| { kind: 'custom' };

export interface CronFields {
	minute: string;
	hour: string;
	dayOfMonth: string;
	month: string;
	dayOfWeek: string;
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const EVERY_N = /^\*\/([1-9]\d*)$/;

/** Splits on runs of whitespace; returns null unless there are exactly five fields. */
export function splitCron(expression: string): CronFields | null {
	const parts = expression.trim().split(/\s+/).filter(Boolean);
	if (parts.length !== CRON_FIELD_COUNT) return null;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
	return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function joinCron(fields: CronFields): string {
	return [fields.minute, fields.hour, fields.dayOfMonth, fields.month, fields.dayOfWeek].join(' ');
}

function asNumber(field: string, min: number, max: number): number | null {
	if (!/^\d+$/.test(field)) return null;
	const n = Number(field);
	return n >= min && n <= max ? n : null;
}

/** A comma-separated list of plain numbers (`1,3,5`) — the only weekday list shape the editor draws. */
function asNumberList(field: string, min: number, max: number): number[] | null {
	const parts = field.split(',');
	const out: number[] = [];
	for (const part of parts) {
		const n = asNumber(part, min, max);
		if (n === null) return null;
		out.push(n);
	}
	const unique = [...new Set(out)].sort((a, b) => a - b);
	return unique.length === out.length ? unique : null;
}

export function parseCronPreset(expression: string): CronPreset {
	const fields = splitCron(expression);
	if (!fields) return { kind: 'custom' };
	const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;
	if (month !== '*') return { kind: 'custom' };

	const anyDay = dayOfMonth === '*';
	const anyWeekday = dayOfWeek === '*';

	if (anyDay && anyWeekday) {
		if (minute === '*' && hour === '*') return { kind: 'everyMinute' };

		const everyNMinutes = EVERY_N.exec(minute);
		if (everyNMinutes && hour === '*') {
			return { kind: 'everyNMinutes', minutes: Number(everyNMinutes[1]) };
		}

		const exactMinute = asNumber(minute, 0, 59);
		if (exactMinute === null) return { kind: 'custom' };

		if (hour === '*') return { kind: 'hourly', minute: exactMinute };

		const everyNHours = EVERY_N.exec(hour);
		if (everyNHours) {
			return { kind: 'everyNHours', hours: Number(everyNHours[1]), minute: exactMinute };
		}

		const exactHour = asNumber(hour, 0, 23);
		if (exactHour === null) return { kind: 'custom' };
		return { kind: 'daily', hour: exactHour, minute: exactMinute };
	}

	const exactMinute = asNumber(minute, 0, 59);
	const exactHour = asNumber(hour, 0, 23);
	if (exactMinute === null || exactHour === null) return { kind: 'custom' };

	if (anyDay) {
		const weekdays = asNumberList(dayOfWeek, 0, 6);
		if (!weekdays || weekdays.length === 0) return { kind: 'custom' };
		return { kind: 'weekly', weekdays, hour: exactHour, minute: exactMinute };
	}

	if (anyWeekday) {
		const day = asNumber(dayOfMonth, 1, 31);
		if (day === null) return { kind: 'custom' };
		return { kind: 'monthly', dayOfMonth: day, hour: exactHour, minute: exactMinute };
	}

	// Both day-of-month and day-of-week constrained — cron ORs them, which the editor doesn't draw.
	return { kind: 'custom' };
}

/**
 * Inverse of `parseCronPreset`. `custom` has no canonical expression of its own (the editor keeps
 * the raw fields for that case), so it yields the every-minute expression as a neutral starting
 * point rather than throwing.
 */
export function buildCronPreset(preset: CronPreset): string {
	switch (preset.kind) {
		case 'everyMinute':
			return '* * * * *';
		case 'everyNMinutes':
			return `*/${preset.minutes} * * * *`;
		case 'everyNHours':
			return `${preset.minute} */${preset.hours} * * *`;
		case 'hourly':
			return `${preset.minute} * * * *`;
		case 'daily':
			return `${preset.minute} ${preset.hour} * * *`;
		case 'weekly':
			return `${preset.minute} ${preset.hour} * * ${[...preset.weekdays].sort((a, b) => a - b).join(',')}`;
		case 'monthly':
			return `${preset.minute} ${preset.hour} ${preset.dayOfMonth} * *`;
		case 'custom':
			return '* * * * *';
	}
}

/**
 * Grammar-level check only — whether each field is *semantically* satisfiable (`31 2 * *` in
 * February) is left to the caller's next-run preview, which simply shows nothing.
 */
export function isValidCronExpression(expression: string): boolean {
	const fields = splitCron(expression);
	if (!fields) return false;
	const ranges: [string, number, number][] = [
		[fields.minute, 0, 59],
		[fields.hour, 0, 23],
		[fields.dayOfMonth, 1, 31],
		[fields.month, 1, 12],
		[fields.dayOfWeek, 0, 7]
	];
	return ranges.every(([field, min, max]) => isValidCronField(field, min, max));
}

function isValidCronField(field: string, min: number, max: number): boolean {
	if (field === '') return false;
	return field.split(',').every((part) => {
		const [value, step] = part.split('/');
		if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false;
		if (value === '*') return true;
		const [from, to] = value.split('-');
		if (to !== undefined) {
			const a = asNumber(from, min, max);
			const b = asNumber(to, min, max);
			return a !== null && b !== null && a <= b;
		}
		return asNumber(value, min, max) !== null;
	});
}
