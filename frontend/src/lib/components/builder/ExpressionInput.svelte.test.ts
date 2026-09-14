import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ExpressionInput from './ExpressionInput.svelte';
import ConditionBuilder from './ConditionBuilder.svelte';
import DataFlowEditor from './DataFlowEditor.svelte';
import type { AvailVar } from './availableVars';

const vars: AvailVar[] = [
	{ source: 'input', path: [], hint: 'workflow input' },
	{ source: 'input', path: ['age'], hint: 'number', type: 'number' },
	{ source: 'data', path: ['user'], hint: 'set by setUser' },
	{ source: 'env', path: ['API_BASE'], hint: 'env var' }
];

function lastCall(fn: ReturnType<typeof vi.fn>): unknown {
	return fn.mock.calls[fn.mock.calls.length - 1]?.[0];
}

describe('ExpressionInput', () => {
	it('shows a hand-written expression as source badge, path and transform', async () => {
		render(ExpressionInput, {
			value: '${ $input.user.name | ascii_downcase }',
			availVars: vars,
			onchange: vi.fn()
		});
		await expect.element(page.getByTitle('Input', { exact: true })).toHaveTextContent('I');
		await expect.element(page.getByText('user.name')).toBeInTheDocument();
		await expect.element(page.getByText('ascii_downcase')).toBeInTheDocument();
	});

	it('builds a variable with a transform from the keyboard', async () => {
		const onchange = vi.fn();
		render(ExpressionInput, { value: '', availVars: vars, onchange });
		const input = page.getByLabelText('Add expression part');

		await input.click();
		await userEvent.keyboard('$data.us');
		await userEvent.keyboard('{Enter}');
		expect(lastCall(onchange)).toBe('${ $data.user }');

		await userEvent.keyboard('|');
		await expect.element(page.getByRole('option', { name: /tostring/ })).toBeInTheDocument();
		await userEvent.keyboard('{Enter}');
		expect(lastCall(onchange)).toBe('${ $data.user | tostring }');

		await userEvent.keyboard('e:API');
		await userEvent.keyboard('{Enter}');
		expect(lastCall(onchange)).toBe('${ ($data.user | tostring) + $env.API_BASE }');

		await userEvent.keyboard('{Backspace}');
		expect(lastCall(onchange)).toBe('${ $data.user | tostring }');
	});

	it('commits plain text as a literal and escapes it', async () => {
		const onchange = vi.fn();
		render(ExpressionInput, { value: '${ $env.API_BASE }', availVars: vars, onchange });
		await page.getByLabelText('Add expression part').click();
		await userEvent.keyboard('"/users/"');
		await userEvent.keyboard('{Enter}');
		expect(lastCall(onchange)).toBe('${ $env.API_BASE + "/users/" }');
	});

	it('re-parses when the value changes from outside (another row, another node, DSL)', async () => {
		const screen = render(ExpressionInput, {
			value: '${ $data.user }',
			availVars: vars,
			onchange: vi.fn()
		});
		await expect.element(page.getByText('user', { exact: true })).toBeInTheDocument();
		await screen.rerender({ value: '${ $env.API_BASE }' });
		await expect.element(page.getByText('API_BASE')).toBeInTheDocument();
		await expect.element(page.getByText('user', { exact: true })).not.toBeInTheDocument();
	});

	it('edits a chip in place: source, path and transformer', async () => {
		const onchange = vi.fn();
		render(ExpressionInput, { value: '${ $data.user }', availVars: vars, onchange });
		await page.getByTitle('Click to edit').click();
		await page.getByRole('radio', { name: 'I' }).click();
		expect(lastCall(onchange)).toBe('${ $input.user }');

		const pathInput = page.getByPlaceholder('field.nested[0]');
		await pathInput.fill('user.email');
		expect(lastCall(onchange)).toBe('${ $input.user.email }');

		await page.getByPlaceholder('tostring | ascii_downcase').fill('ascii_downcase');
		expect(lastCall(onchange)).toBe('${ $input.user.email | ascii_downcase }');
	});
});

describe('DataFlowEditor', () => {
	it('exports the task result to context and loads it back as keys', async () => {
		const onchange = vi.fn();
		render(DataFlowEditor, {
			outputAs: '',
			exportAs: '',
			taskName: 'fetchUser',
			availVars: vars,
			onchange
		});
		await page.getByRole('radio', { name: 'Add keys' }).click();
		expect(lastCall(onchange)).toEqual({ exportAs: '${ $context + { fetchUser: . } }' });

		await page.getByRole('radio', { name: 'Pick fields' }).click();
		await page.getByPlaceholder('key').first().fill('id');
		expect(lastCall(onchange)).toEqual({ outputAs: '{"id":""}' });
	});

	it('opens a hand-written context merge in key mode', async () => {
		render(DataFlowEditor, {
			outputAs: '',
			exportAs: '${ $context + { profile: .profile } }',
			taskName: 't',
			availVars: vars,
			onchange: vi.fn()
		});
		await expect
			.element(page.getByRole('radio', { name: 'Add keys' }))
			.toHaveAttribute('aria-checked', 'true');
		await expect.element(page.getByPlaceholder('key')).toHaveValue('profile');
	});
});

describe('ConditionBuilder', () => {
	it('builds a typed comparison', async () => {
		const onchange = vi.fn();
		render(ConditionBuilder, { value: '', availVars: vars, onchange });
		await page.getByText('+ add condition').click();
		await page.getByLabelText('Add expression part').click();
		await userEvent.keyboard('$input.age');
		await userEvent.keyboard('{Enter}');
		await page.getByLabelText('Operator').selectOptions('>=');
		// `age` is declared as a number, so the right operand became a number field.
		await page.getByPlaceholder('0').fill('18');
		expect(lastCall(onchange)).toBe('${ $input.age >= 18 }');
	});

	it('keeps each row intact when an earlier row is removed', async () => {
		const onchange = vi.fn();
		render(ConditionBuilder, {
			value: '${ $data.user == "a" or $env.API_BASE != null }',
			availVars: vars,
			onchange
		});
		await expect.element(page.getByText('user', { exact: true })).toBeInTheDocument();
		await page.getByRole('button', { name: 'Remove condition' }).first().click();
		expect(lastCall(onchange)).toBe('${ $env.API_BASE != null }');
		await expect.element(page.getByText('API_BASE')).toBeInTheDocument();
		await expect.element(page.getByText('user', { exact: true })).not.toBeInTheDocument();
	});
});
