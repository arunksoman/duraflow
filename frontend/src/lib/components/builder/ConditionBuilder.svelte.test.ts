import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ConditionBuilder from './ConditionBuilder.svelte';
import type { AvailVar } from './availableVars';

const availVars: AvailVar[] = [
	{
		expr: '${ $input.total }',
		hint: 'number',
		category: 'input',
		source: '$input',
		field: 'total',
		rawRef: '$input.total'
	}
];

function setup(value: string) {
	const onchange = vi.fn<(v: string) => void>();
	const screen = render(ConditionBuilder, { value, availVars, onchange });
	const last = () => onchange.mock.lastCall?.[0];
	return { screen, onchange, last };
}

const operator = (screen: ReturnType<typeof setup>['screen'], n = 0) =>
	screen.container.querySelectorAll('select')[n] as HTMLSelectElement;

describe('ConditionBuilder', () => {
	it('builds a condition from scratch', async () => {
		const { screen, last } = setup('');
		await screen.getByRole('button', { name: '+ add condition' }).click();
		expect(last()).toBe('${ $input.total == "" }');

		await screen.getByTitle('click to set value').click();
		await userEvent.keyboard('paid');
		expect(last()).toBe('${ $input.total == "paid" }');
		await userEvent.keyboard('{Enter}');
		await expect.element(screen.getByText('paid')).toBeVisible();
	});

	it('parses an existing condition into clauses joined by and/or', async () => {
		const { screen, last } = setup('${ $input.total > 100 and .status != "done" }');
		await expect.element(screen.getByTitle('Toggle and / or')).toHaveTextContent('and');
		expect(operator(screen, 0).value).toBe('>');
		expect(operator(screen, 1).value).toBe('!=');

		await screen.getByTitle('Toggle and / or').click();
		expect(last()).toBe('${ $input.total > 100 or .status != "done" }');

		await screen.getByLabelText('Remove condition').first().click();
		expect(last()).toBe('${ .status != "done" }');
	});

	it('cycles value types', async () => {
		const { screen, last } = setup('${ .a == "x" }');
		const typeButton = () => screen.getByTitle(/^Value type:/);

		await typeButton().click(); // str -> num
		expect(last()).toBe('${ .a == 0 }');
		await userEvent.keyboard('42');
		expect(last()).toBe('${ .a == 42 }');
		await userEvent.keyboard('{Escape}');
		await expect.element(screen.getByTitle('42')).toBeVisible();

		await typeButton().click(); // num -> bool
		expect(last()).toBe('${ .a == true }');
		await screen.getByRole('button', { name: 'true', exact: true }).click();
		expect(last()).toBe('${ .a == false }');

		await typeButton().click(); // bool -> null
		expect(last()).toBe('${ .a == null }');
		await expect.element(screen.getByText('null', { exact: true })).toBeVisible();

		await typeButton().click(); // null -> var
		expect(last()).toBe('${ .a == $input.total }');

		await typeButton().click(); // var -> str
		expect(last()).toBe('${ .a == "" }');
	});

	it('supports a falsy test', async () => {
		const { screen, last } = setup('${ .a == 1 }');
		await userEvent.selectOptions(operator(screen), '| not');
		expect(last()).toBe('${ .a | not }');
		await expect.element(screen.getByText('is falsy')).toBeVisible();
		expect(screen.getByTitle(/^Value type:/).elements()).toHaveLength(0);
	});

	it('reads the other value shapes', async () => {
		const shapes: [string, string][] = [
			["${ .a == 'single' }", '"single"'],
			['${ .a == 1.5 }', '1.5'],
			['${ .a == null }', 'null'],
			['${ .a == $data.b }', '$data.b'],
			['${ .a == bare }', '"bare"'],
			['${ .a | not }', '| not']
		];
		for (const [input, fragment] of shapes) {
			const { screen, last } = setup(input);
			await screen.getByRole('button', { name: '+ add condition' }).click();
			expect(last(), input).toContain(fragment);
			screen.unmount();
		}
	});

	it('falls back to a raw editor for expressions it cannot draw, and back', async () => {
		const { screen, last } = setup('${ (.a | length) > 2 and contains("x") }');
		const raw = screen.getByRole('textbox').first();
		await expect.element(raw).toHaveValue('${ (.a | length) > 2 and contains("x") }');
		await raw.fill('${ .ok == true }');
		expect(last()).toBe('${ .ok == true }');

		await screen.getByRole('button', { name: 'chip' }).click();
		expect(last()).toBe('${ .ok == true }');
		await expect.element(screen.getByRole('button', { name: 'true', exact: true })).toBeVisible();

		await screen.getByTitle('Edit raw jq expression').click();
		await expect.element(screen.getByRole('textbox').first()).toHaveValue('${ .ok == true }');
		await screen.getByRole('textbox').first().fill('not parseable at all');
		await screen.getByRole('button', { name: 'chip' }).click();
		// Unparseable text stays in the raw editor rather than being dropped.
		await expect.element(screen.getByRole('button', { name: 'chip' })).toBeVisible();
		expect(last()).toBe('not parseable at all');
	});

	it('clears when the last clause is removed', async () => {
		const { screen, last } = setup('${ .a == 1 or .b == 2 }');
		await screen.getByLabelText('Remove condition').nth(1).click();
		expect(last()).toBe('${ .a == 1 }');
		expect(screen.getByLabelText('Remove condition').elements()).toHaveLength(0);
	});

	it('follows an external value change', async () => {
		const { screen } = setup('${ .a == 1 }');
		await screen.rerender({ value: '${ .b != "z" }' });
		expect(operator(screen).value).toBe('!=');
		await screen.rerender({ value: 'weird ((' });
		await expect.element(screen.getByRole('button', { name: 'chip' })).toBeVisible();
		await screen.rerender({ value: '' });
		await expect.element(screen.getByRole('button', { name: '+ add condition' })).toBeVisible();
	});
});
