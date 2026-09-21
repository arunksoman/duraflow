import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ExpressionInput from './ExpressionInput.svelte';
import type { AvailVar } from './availableVars';

const availVars: AvailVar[] = [
	{
		expr: '${ $input.userId }',
		hint: 'number',
		category: 'input',
		source: '$input',
		field: 'userId',
		rawRef: '$input.userId'
	},
	{
		expr: '${ $data.uuid }',
		hint: '',
		category: 'data',
		source: '$data',
		field: 'uuid',
		rawRef: '$data.uuid'
	}
];

const ENDPOINT = '${ "https://example.com/users/" + ($input.userId | tostring) }';

function setup(value: string) {
	const emitted: string[] = [];
	const screen = render(ExpressionInput, {
		props: { value, availVars, onchange: (v: string) => emitted.push(v) }
	});
	const last = () => emitted.at(-1) ?? value;
	const blur = () => (document.activeElement as HTMLElement | null)?.blur();
	return { screen, emitted, last, blur };
}

describe('ExpressionInput chip editing', () => {
	it('restores an untouched variable chip in place, transform included', async () => {
		const { screen, last, blur } = setup(ENDPOINT);
		await screen.getByText('userId').click();
		blur();
		await expect.element(screen.getByText('userId')).toBeVisible();
		await expect.element(screen.getByText('| tostring')).toBeVisible();
		expect(last()).toBe(ENDPOINT);
	});

	it('does not reorder or drop chips when clicking one chip after another', async () => {
		const { screen, last, blur } = setup(ENDPOINT);
		await screen.getByTitle('https://example.com/users/').click();
		await screen.getByText('userId').click();
		await screen.getByText('userId').click();
		blur();
		expect(last()).toBe(ENDPOINT);
	});

	it('commits an edited literal in its own slot', async () => {
		const { screen, last, blur } = setup(ENDPOINT);
		await screen.getByTitle('https://example.com/users/').click();
		const input = screen.getByLabelText('Add expression part');
		await userEvent.clear(input);
		await userEvent.type(input, 'https://api.test/u/');
		blur();
		expect(last()).toBe('${ "https://api.test/u/" + ($input.userId | tostring) }');
	});

	it('keeps the transform when swapping the variable of an edited chip', async () => {
		const { screen, last } = setup(ENDPOINT);
		await screen.getByText('userId').click();
		const input = screen.getByLabelText('Add expression part');
		await userEvent.clear(input);
		await userEvent.type(input, 'uuid');
		await userEvent.keyboard('{Enter}');
		expect(last()).toBe('${ "https://example.com/users/" + ($data.uuid | tostring) }');
	});

	it('escapes quotes in string literals and round-trips them', async () => {
		const value = '${ "say \\"hi\\" " + $input.userId }';
		const { screen, last, blur } = setup(value);
		await screen.getByTitle('say "hi" ').click();
		blur();
		expect(last()).toBe(value);
	});

	it('keeps a parenthesised sub-expression as its own chip', async () => {
		const value = '${ "at " + (now | strftime("%Y")) }';
		const { screen, last, blur } = setup(value);
		await screen.getByTitle('at ').click();
		blur();
		expect(last()).toBe(value);
	});

	it('re-parses when the value prop changes from outside', async () => {
		const { screen } = setup('${ $input.userId }');
		await screen.rerender({ value: '${ $data.uuid }' });
		await expect.element(screen.getByText('uuid')).toBeVisible();
		expect(screen.getByText('userId').query()).toBeNull();
	});
});
