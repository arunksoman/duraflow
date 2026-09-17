import { describe, it, expect } from 'vitest';
import type { ZigflowDocument } from './ast';
import {
	applyWorkflowSchedule,
	defaultWorkflowSchedule,
	isScheduleActive,
	readWorkflowSchedule,
	type WorkflowSchedule
} from './schedule';

function docWith(partial: Partial<ZigflowDocument>): ZigflowDocument {
	return {
		document: { dsl: '1.0.0', taskQueue: 'zigflow', workflowType: 'nightly', version: '0.1.0' },
		do: [],
		...partial
	};
}

describe('readWorkflowSchedule', () => {
	it('reads an off-by-default schedule from a document with none', () => {
		expect(readWorkflowSchedule(docWith({}))).toEqual(defaultWorkflowSchedule());
	});

	it('reads a cron schedule plus its metadata', () => {
		const schedule = readWorkflowSchedule(
			docWith({
				document: {
					dsl: '1.0.0',
					taskQueue: 'zigflow',
					workflowType: 'nightly',
					version: '0.1.0',
					metadata: {
						scheduleWorkflowName: 'nightly',
						scheduleId: 'some-schedule',
						scheduleInput: [{ msg: 'hello' }]
					}
				},
				schedule: { cron: '0 0 * * *' }
			})
		);

		expect(schedule).toMatchObject({
			enabled: true,
			useCron: true,
			cron: '0 0 * * *',
			useInterval: false,
			scheduleId: 'some-schedule',
			workflowName: 'nightly',
			input: { msg: 'hello' }
		});
	});

	it('reads cron and interval together — zigflow fires on either', () => {
		const schedule = readWorkflowSchedule(
			docWith({ schedule: { cron: '0 0 * * *', every: { minutes: 3 } } })
		);
		expect(schedule.useCron).toBe(true);
		expect(schedule.useInterval).toBe(true);
		expect(schedule.every).toEqual({ minutes: 3 });
	});

	it('restores a parked configuration when the schedule is switched off', () => {
		const schedule = readWorkflowSchedule(
			docWith({
				document: {
					dsl: '1.0.0',
					taskQueue: 'zigflow',
					workflowType: 'nightly',
					version: '0.1.0',
					metadata: {
						duraflow: {
							disabledSchedule: {
								useCron: true,
								useInterval: false,
								cron: '30 4 * * 1',
								scheduleId: 'weekly-report'
							}
						}
					}
				}
			})
		);

		expect(schedule).toMatchObject({
			enabled: false,
			useCron: true,
			cron: '30 4 * * 1',
			scheduleId: 'weekly-report'
		});
	});
});

describe('applyWorkflowSchedule', () => {
	const base = defaultWorkflowSchedule();

	it('emits schedule: plus the metadata zigflow requires', () => {
		const parts = applyWorkflowSchedule(
			{ ...base, enabled: true, useCron: true, cron: '0 0 * * *' },
			undefined,
			'nightly'
		);
		expect(parts.schedule).toEqual({ cron: '0 0 * * *' });
		expect(parts.metadata).toEqual({ scheduleWorkflowName: 'nightly' });
	});

	it('wraps the schedule input in a list — Temporal takes workflow arguments', () => {
		const parts = applyWorkflowSchedule(
			{ ...base, enabled: true, useCron: true, cron: '0 0 * * *', input: { msg: 'hi' } },
			undefined,
			'nightly'
		);
		expect(parts.metadata?.scheduleInput).toEqual([{ msg: 'hi' }]);
	});

	it('drops zero-valued duration components', () => {
		const parts = applyWorkflowSchedule(
			{
				...base,
				enabled: true,
				useCron: false,
				useInterval: true,
				every: { hours: 0, minutes: 3, seconds: 0 }
			},
			undefined,
			'nightly'
		);
		expect(parts.schedule).toEqual({ every: { minutes: 3 } });
	});

	it('removes schedule: and parks the config when switched off', () => {
		const parts = applyWorkflowSchedule(
			{ ...base, enabled: false, useCron: true, cron: '30 4 * * 1' },
			{ scheduleWorkflowName: 'nightly', scheduleId: 'old' },
			'nightly'
		);
		expect(parts.schedule).toBeUndefined();
		// Both drafts are parked, not just the selected one, so flicking the toggle loses nothing.
		expect(parts.metadata).toEqual({
			duraflow: {
				disabledSchedule: {
					useCron: true,
					useInterval: false,
					cron: '30 4 * * 1',
					every: { minutes: 5 }
				}
			}
		});
	});

	it('never leaves both representations in the document at once', () => {
		const off = applyWorkflowSchedule(
			{ ...base, enabled: false, useCron: true, cron: '0 0 * * *' },
			undefined,
			'nightly'
		);
		const on = applyWorkflowSchedule(
			{ ...base, enabled: true, useCron: true, cron: '0 0 * * *' },
			off.metadata,
			'nightly'
		);
		expect(on.schedule).toEqual({ cron: '0 0 * * *' });
		expect(on.metadata?.duraflow).toBeUndefined();
	});

	it('preserves unrelated metadata through both transitions', () => {
		const on = applyWorkflowSchedule(
			{ ...base, enabled: true, useCron: true, cron: '0 0 * * *' },
			{ owner: 'platform', duraflow: { somethingElse: 1 } },
			'nightly'
		);
		expect(on.metadata).toMatchObject({ owner: 'platform', duraflow: { somethingElse: 1 } });

		const off = applyWorkflowSchedule(
			{ ...base, enabled: false, useCron: true, cron: '0 0 * * *' },
			on.metadata,
			'nightly'
		);
		expect(off.metadata).toMatchObject({ owner: 'platform' });
		expect((off.metadata?.duraflow as Record<string, unknown>).somethingElse).toBe(1);
	});

	it('leaves no metadata at all for a workflow that was never scheduled', () => {
		expect(applyWorkflowSchedule(undefined, undefined, 'nightly').metadata).toBeUndefined();
		expect(applyWorkflowSchedule(base, undefined, 'nightly').metadata).toBeUndefined();
	});

	it('round-trips through readWorkflowSchedule', () => {
		const schedule: WorkflowSchedule = {
			enabled: true,
			useInterval: true,
			every: { minutes: 3 },
			useCron: true,
			cron: '0 0 * * *',
			scheduleId: 'some-schedule',
			workflowName: 'other-workflow',
			input: { msg: ['hello', 'world'] }
		};
		const parts = applyWorkflowSchedule(schedule, undefined, 'nightly');
		const back = readWorkflowSchedule(
			docWith({
				document: {
					dsl: '1.0.0',
					taskQueue: 'zigflow',
					workflowType: 'nightly',
					version: '0.1.0',
					metadata: parts.metadata
				},
				schedule: parts.schedule
			})
		);
		expect(back).toEqual(schedule);
	});
});

describe('isScheduleActive', () => {
	const base = defaultWorkflowSchedule();

	it('is false when disabled, and when enabled with no usable spec', () => {
		expect(isScheduleActive(undefined)).toBe(false);
		expect(isScheduleActive({ ...base, enabled: false, useCron: true })).toBe(false);
		expect(isScheduleActive({ ...base, enabled: true, useCron: false, useInterval: false })).toBe(
			false
		);
		expect(isScheduleActive({ ...base, enabled: true, useCron: true, cron: '  ' })).toBe(false);
	});

	it('is true for either spec kind', () => {
		expect(isScheduleActive({ ...base, enabled: true, useCron: true })).toBe(true);
		expect(
			isScheduleActive({
				...base,
				enabled: true,
				useCron: false,
				useInterval: true,
				every: { minutes: 5 }
			})
		).toBe(true);
	});
});
