import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import CronBuilder from './builder/CronBuilder.svelte';
import ScheduleModal from './builder/ScheduleModal.svelte';
import { defaultWorkflowSchedule, type WorkflowSchedule } from '$lib/zigflow-engine/schedule';

/** The <select> offering an option with this value. */
function selectHolding(value: string): HTMLSelectElement {
	const match = [...document.querySelectorAll('select')].find((s) =>
		[...s.options].some((o) => o.value === value)
	);
	if (!match) throw new Error(`no select offers ${value}`);
	return match;
}

/** Sets an input's value and fires `change`, the event these controls commit on. */
async function commit(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

function cron(value: string) {
	const onchange = vi.fn();
	const screen = render(CronBuilder, { value, onchange });
	return { screen, onchange };
}

describe('CronBuilder', () => {
	it('describes a valid expression and its next UTC runs', async () => {
		const { screen } = cron('30 9 * * *');
		await expect.element(screen.getByText(/At 09:30 AM/)).toBeVisible();
		await expect.element(screen.getByText(/^Next: .* UTC$/)).toBeVisible();
		expect(selectHolding('daily').value).toBe('daily');
	});

	it('flags an invalid expression', async () => {
		const { screen } = cron('not a cron');
		await expect.element(screen.getByText(/Not a valid 5-field cron/)).toBeVisible();
	});

	it('emits typed expressions as-is', async () => {
		const { screen, onchange } = cron('0 0 * * *');
		await screen.getByPlaceholder('0 0 * * *').fill('5 4 * * *');
		expect(onchange).toHaveBeenLastCalledWith('5 4 * * *');
	});

	it.each([
		['everyMinute', '* * * * *'],
		['everyNMinutes', '*/15 * * * *'],
		['everyNHours', '30 */6 * * *'],
		['hourly', '30 * * * *'],
		['daily', '30 9 * * *'],
		['weekly', '30 9 * * 1'],
		['monthly', '30 9 1 * *']
	])('switching to %s keeps the time of day', async (kind, expected) => {
		const { onchange } = cron('30 9 * * *');
		await userEvent.selectOptions(selectHolding(kind), kind);
		expect(onchange).toHaveBeenLastCalledWith(expected);
	});

	it('defaults the time when the current expression has none', async () => {
		const { onchange } = cron('* * * * *');
		await userEvent.selectOptions(selectHolding('daily'), 'daily');
		expect(onchange).toHaveBeenLastCalledWith('0 9 * * *');
	});

	it('edits every-N-minutes and every-N-hours', async () => {
		const minutes = cron('*/15 * * * *');
		const [n] = minutes.screen.getByRole('spinbutton').elements() as HTMLInputElement[];
		await commit(n, '20');
		expect(minutes.onchange).toHaveBeenLastCalledWith('*/20 * * * *');
		await commit(n, '90'); // out of range: ignored
		expect(minutes.onchange).toHaveBeenCalledTimes(1);
		minutes.screen.unmount();

		const hours = cron('10 */6 * * *');
		const [h, m] = hours.screen.getByRole('spinbutton').elements() as HTMLInputElement[];
		await commit(h, '2');
		expect(hours.onchange).toHaveBeenLastCalledWith('10 */2 * * *');
		await commit(m, '45');
		expect(hours.onchange).toHaveBeenLastCalledWith('45 */6 * * *');
		await commit(h, '30');
		await commit(m, '75');
		expect(hours.onchange).toHaveBeenCalledTimes(2);
	});

	it('edits hourly and monthly', async () => {
		const hourly = cron('5 * * * *');
		const [minute] = hourly.screen.getByRole('spinbutton').elements() as HTMLInputElement[];
		await commit(minute, '50');
		expect(hourly.onchange).toHaveBeenLastCalledWith('50 * * * *');
		await commit(minute, '99');
		expect(hourly.onchange).toHaveBeenCalledTimes(1);
		hourly.screen.unmount();

		const monthly = cron('0 8 1 * *');
		const [day] = monthly.screen.getByRole('spinbutton').elements() as HTMLInputElement[];
		await commit(day, '15');
		expect(monthly.onchange).toHaveBeenLastCalledWith('0 8 15 * *');
		await commit(day, '40');
		expect(monthly.onchange).toHaveBeenCalledTimes(1);
		const time = document.querySelector<HTMLInputElement>('input[type="time"]')!;
		await commit(time, '17:05');
		expect(monthly.onchange).toHaveBeenLastCalledWith('5 17 1 * *');
		await commit(time, 'nonsense');
		expect(monthly.onchange).toHaveBeenCalledTimes(2);
	});

	it('toggles weekdays but never leaves none selected', async () => {
		const { screen, onchange } = cron('0 9 * * 1');
		await expect
			.element(screen.getByRole('button', { name: 'Mon' }))
			.toHaveAttribute('aria-pressed', 'true');
		await screen.getByRole('button', { name: 'Wed' }).click();
		expect(onchange).toHaveBeenLastCalledWith('0 9 * * 1,3');
		await screen.getByRole('button', { name: 'Mon' }).click();
		expect(onchange).toHaveBeenCalledTimes(1);
	});

	it('edits raw fields in custom mode', async () => {
		const { screen, onchange } = cron('0 9 1 6 *');
		expect(selectHolding('custom').value).toBe('custom');
		const raw = screen.getByRole('textbox').elements() as HTMLInputElement[];
		// minute, hour, day of month, month, day of week, then the expression itself
		await commit(raw[3], '7');
		expect(onchange).toHaveBeenLastCalledWith('0 9 1 7 *');
		await commit(raw[0], '  ');
		expect(onchange).toHaveBeenLastCalledWith('* 9 1 6 *');
	});

	it('can force the raw editor for an expression the presets understand', async () => {
		const { screen, onchange } = cron('0 9 * * *');
		await userEvent.selectOptions(selectHolding('custom'), 'custom');
		expect(onchange).not.toHaveBeenCalled();
		await expect.element(screen.getByText('Day of week')).toBeVisible();
	});
});

describe('ScheduleModal', () => {
	function modal(schedule: Partial<WorkflowSchedule> = {}, inputFields = [] as never[]) {
		const onupdate = vi.fn<(s: WorkflowSchedule) => void>();
		const onclose = vi.fn();
		const screen = render(ScheduleModal, {
			schedule: { ...defaultWorkflowSchedule(), ...schedule },
			workflowType: 'nightly',
			inputFields,
			onupdate,
			onclose
		});
		const last = () => onupdate.mock.lastCall?.[0];
		return { screen, onupdate, onclose, last };
	}

	it('turning it on defaults to cron', async () => {
		const { screen, last } = modal();
		await expect.element(screen.getByText(/Off — this workflow only runs/)).toBeVisible();
		await screen.getByLabelText('Run on a schedule').click();
		expect(last()).toMatchObject({ enabled: true, useCron: true });
		await expect.element(screen.getByText(/Runs at 12:00 am \(UTC\)/i)).toBeVisible();
	});

	it('keeps an existing choice when turned on, and can turn off', async () => {
		const { screen, last } = modal({ useInterval: true, every: { minutes: 5 } });
		await screen.getByLabelText('Run on a schedule').click();
		expect(last()).toMatchObject({ enabled: true, useCron: false, useInterval: true });
		await expect.element(screen.getByText('Runs every 5 minutes (UTC).')).toBeVisible();
		await screen.getByLabelText('Run on a schedule').click();
		expect(last()?.enabled).toBe(false);
	});

	it('edits the interval and warns when it is empty', async () => {
		const { screen, last } = modal({ enabled: true, useInterval: true, every: { minutes: 5 } });
		const [days, hours, minutes] = screen.getByRole('spinbutton').elements() as HTMLInputElement[];
		await commit(hours, '2');
		expect(last()?.every).toMatchObject({ hours: 2, minutes: 5 });
		await expect.element(screen.getByText('Runs every 2 hours 5 minutes (UTC).')).toBeVisible();
		await commit(hours, '-3');
		await commit(minutes, 'x');
		await commit(days, '0');
		expect(last()?.every).toMatchObject({ days: 0, hours: 0, minutes: 0 });
		await expect.element(screen.getByText('Set at least one non-zero value.')).toBeVisible();
		await expect.element(screen.getByText(/The schedule is incomplete/)).toBeVisible();
	});

	it('combines interval and cron', async () => {
		const { screen } = modal({
			enabled: true,
			useInterval: true,
			useCron: true,
			cron: '0 6 * * *'
		});
		await expect.element(screen.getByText(/Both are set/)).toBeVisible();
		await expect
			.element(screen.getByText(/Runs every 5 minutes, and at 06:00 am \(UTC\)/i))
			.toBeVisible();
	});

	it('asks for a spec when both are off', async () => {
		const { screen, last } = modal({ enabled: true, useCron: true });
		const [interval, cronBox] = screen
			.getByRole('checkbox')
			.elements()
			.slice(1) as HTMLInputElement[];
		await cronBox.click();
		expect(last()?.useCron).toBe(false);
		await expect.element(screen.getByText('Pick an interval or a cron expression.')).toBeVisible();
		await interval.click();
		expect(last()?.useInterval).toBe(true);
	});

	it('flags an invalid cron as incomplete', async () => {
		const { screen } = modal({ enabled: true, useCron: true, cron: 'bad' });
		await expect.element(screen.getByText('Incomplete schedule.')).toBeVisible();
		await expect.element(screen.getByText(/The schedule is incomplete/)).toBeVisible();
	});

	it('edits identity and seeds input from the $input schema', async () => {
		const { screen, last, onclose } = modal({ enabled: true, useCron: true }, [
			{ name: 'region', type: 'string' }
		] as never);
		await screen.getByText(/Schedule input & identity/).click();

		const workflowName = screen.getByPlaceholder('nightly', { exact: true });
		await workflowName.fill(' other ');
		(workflowName.element() as HTMLInputElement).dispatchEvent(
			new Event('change', { bubbles: true })
		);
		expect(last()?.workflowName).toBe('other');

		const scheduleId = screen.getByPlaceholder('zigflow_nightly');
		await scheduleId.fill('custom-id');
		(scheduleId.element() as HTMLInputElement).dispatchEvent(
			new Event('change', { bubbles: true })
		);
		expect(last()?.scheduleId).toBe('custom-id');

		await screen.getByRole('button', { name: 'Fill from $input schema' }).click();
		expect(last()?.input).toEqual({ region: '' });

		await screen.getByRole('button', { name: 'Done' }).click();
		expect(onclose).toHaveBeenCalled();
	});

	it('validates hand-edited schedule input', async () => {
		const { screen, last } = modal({ enabled: true, useCron: true, input: { a: 1 } });
		await screen.getByText(/Schedule input & identity/).click();
		const editor = screen.container.querySelector<HTMLElement>('.cm-content')!;
		const type = (text: string) => userEvent.fill(editor, text);

		await type('[1]');
		await expect.element(screen.getByText('Schedule input must be a JSON object.')).toBeVisible();
		await type('{oops');
		await expect.element(screen.getByText('Not valid JSON.')).toBeVisible();
		await type('{"b": 2}');
		expect(last()?.input).toEqual({ b: 2 });
		await type('');
		expect(last()?.input).toBeNull();

		await screen.getByRole('button', { name: 'Start from {}' }).click();
		expect(last()?.input).toEqual({});
	});
});
