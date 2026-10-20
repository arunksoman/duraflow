import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { InputField, WorkflowMeta } from '$lib/types';
import InputFormHarness from '$lib/testing/InputFormHarness.svelte';
import WorkflowVariablesModal from './builder/WorkflowVariablesModal.svelte';
import NodePalette from './builder/NodePalette.svelte';
import { NODE_META } from './builder/builderConfig';

function inputForm(fields: InputField[], initial: Record<string, unknown> = {}, errors = {}) {
	const values: Record<string, unknown>[] = [];
	const jsonErrors: (string | null)[] = [];
	const screen = render(InputFormHarness, {
		fields,
		initial,
		errors,
		onvalue: (v: Record<string, unknown>) => values.push(v),
		onjsonerror: (m: string | null) => jsonErrors.push(m)
	});
	const value = () => values.at(-1) ?? {};
	const editor = () => screen.container.querySelector<HTMLElement>('.cm-content')!;
	return { screen, value, jsonErrors, editor };
}

const fields: InputField[] = [
	{ name: 'name', type: 'string', required: true, description: 'Who to greet', example: 'Ada' },
	{ name: 'count', type: 'number' },
	{ name: 'loud', type: 'boolean' },
	{ name: 'tags', type: 'array', itemsType: 'string' },
	{ name: 'scores', type: 'array', itemsType: 'number' },
	{ name: 'meta', type: 'object' },
	{ name: '', type: 'string' }
] as InputField[];

describe('WorkflowInputForm', () => {
	it('fills in a skeleton for every declared field', async () => {
		const { value } = inputForm(fields);
		await expect
			.poll(() => Object.keys(value()).sort())
			.toEqual(['count', 'loud', 'meta', 'name', 'scores', 'tags'].sort());
	});

	it('edits each field type', async () => {
		const { screen, value } = inputForm(fields, {}, { name: 'Required.' });
		await expect.element(screen.getByText('Who to greet')).toBeVisible();
		await expect.element(screen.getByText('Required.')).toBeVisible();
		await expect.element(screen.getByText('array of number')).toBeVisible();

		await screen.getByPlaceholder('Ada').fill('Grace');
		expect(value().name).toBe('Grace');

		const count = screen.container.querySelector<HTMLInputElement>('#run-input-count')!;
		await userEvent.fill(count, '42');
		expect(value().count).toBe(42);
		await userEvent.clear(count);
		expect(value().count).toBe('');

		await userEvent.click(screen.container.querySelector('#run-input-loud')!);
		expect(value().loud).toBe(true);

		const addItem = screen.getByRole('button', { name: 'Add item' });
		await addItem.nth(0).click();
		await addItem.nth(0).click();
		await addItem.nth(1).click();
		expect(value().tags).toEqual(['', '']);
		expect(value().scores).toEqual([0]);

		const items = () =>
			[...screen.container.querySelectorAll('button[aria-label^="Remove item"]')].map(
				(b) => b.previousElementSibling as HTMLInputElement
			);
		await userEvent.fill(items()[0], 'red');
		await userEvent.fill(items()[2], '7');
		expect(value().tags).toEqual(['red', '']);
		expect(value().scores).toEqual([7]);
		await screen.getByLabelText('Remove item 2').first().click();
		expect(value().tags).toEqual(['red']);

		const objectEditor = screen.container.querySelector<HTMLElement>('.cm-content')!;
		await userEvent.fill(objectEditor, '{"k": 1}');
		expect(value().meta).toEqual({ k: 1 });
		await userEvent.fill(objectEditor, '{bad');
		expect(value().meta).toBe('{bad');
		await userEvent.fill(objectEditor, '');
		expect(value().meta).toEqual({});
	});

	it('round-trips through the JSON tab', async () => {
		const { screen, value, jsonErrors, editor } = inputForm(
			[{ name: 'count', type: 'number' }] as InputField[],
			{ count: 3 }
		);
		await screen.getByRole('tab', { name: 'JSON' }).click();
		await expect.element(screen.getByText('"count": 3', { exact: false })).toBeVisible();

		await userEvent.fill(editor(), '{"count": "9"}');
		expect(value().count).toBe(9); // coerced to the declared type

		await userEvent.fill(editor(), '[1]');
		await expect.element(screen.getByText('Input must be a JSON object.')).toBeVisible();
		// Can't leave the tab while the text is invalid.
		await screen.getByRole('tab', { name: 'Form' }).click();
		await expect.element(screen.getByText('Input must be a JSON object.')).toBeVisible();

		await userEvent.fill(editor(), 'nope');
		await expect.element(screen.getByText('Not valid JSON.')).toBeVisible();
		expect(jsonErrors).toContain('Not valid JSON.');

		await userEvent.fill(editor(), '');
		expect(value()).toEqual({});
		await screen.getByRole('tab', { name: 'Form' }).click();
		await expect.element(screen.getByRole('spinbutton')).toBeVisible();
		expect(jsonErrors.at(-1)).toBeNull();
	});

	it('offers only raw JSON when nothing is declared', async () => {
		const { screen, value, editor } = inputForm([]);
		await expect.element(screen.getByText(/declares no/)).toBeVisible();
		expect(screen.getByRole('tab').elements()).toHaveLength(0);
		await userEvent.fill(editor(), '{"free": true}');
		expect(value()).toEqual({ free: true });
	});
});

describe('WorkflowVariablesModal', () => {
	const meta = {
		workflowType: 'orders',
		taskQueue: 'q',
		envVars: [{ name: 'API', description: 'base', example: 'https://x' }]
	} as WorkflowMeta;

	it('edits document metadata', async () => {
		const onupdate = vi.fn();
		const onclose = vi.fn();
		const screen = render(WorkflowVariablesModal, { meta, onupdate, onclose });
		await expect.element(screen.getByLabelText('version')).toHaveValue('0.1.0');

		await screen.getByLabelText('workflowType').fill('billing');
		expect(onupdate).toHaveBeenLastCalledWith({ workflowType: 'billing' });
		await screen.getByLabelText('taskQueue').fill('q2');
		expect(onupdate).toHaveBeenLastCalledWith({ taskQueue: 'q2' });
		await screen.getByLabelText('version').fill('1.0.0');
		expect(onupdate).toHaveBeenLastCalledWith({ version: '1.0.0' });

		await screen.getByRole('button', { name: 'Done' }).click();
		expect(onclose).toHaveBeenCalled();
	});

	it('adds, edits and removes env vars', async () => {
		const onupdate = vi.fn();
		const screen = render(WorkflowVariablesModal, { meta, onupdate, onclose: () => {} });
		await screen.getByRole('button', { name: 'Add variable' }).click();
		expect(onupdate).toHaveBeenLastCalledWith({
			envVars: [meta.envVars![0], { name: '', description: '', example: '' }]
		});

		await screen.getByPlaceholder('API_BASE').nth(1).fill('TOKEN');
		await screen.getByPlaceholder('Base URL for API').nth(1).fill('auth');
		await screen.getByPlaceholder('https://api.example.com').nth(1).fill('abc');
		expect(onupdate.mock.lastCall?.[0].envVars[1]).toEqual({
			name: 'TOKEN',
			description: 'auth',
			example: 'abc'
		});

		await screen.getByLabelText('Remove env var').first().click();
		expect(onupdate.mock.lastCall?.[0].envVars).toEqual([
			{ name: 'TOKEN', description: 'auth', example: 'abc' }
		]);
		await screen.getByLabelText('Remove env var').first().click();
		await expect.element(screen.getByText(/No env vars defined/)).toBeVisible();
	});

	it('starts from defaults for an empty meta', async () => {
		const screen = render(WorkflowVariablesModal, {
			meta: {} as WorkflowMeta,
			onupdate: () => {},
			onclose: () => {}
		});
		await expect.element(screen.getByLabelText('workflowType')).toHaveValue('');
		await expect.element(screen.getByText(/No env vars defined/)).toBeVisible();
	});
});

describe('NodePalette', () => {
	it('adds nodes by click, keyboard and drag', async () => {
		const onaddnode = vi.fn();
		const screen = render(NodePalette, { onaddnode });
		await expect.element(screen.getByText('Node Palette')).toBeVisible();
		expect(screen.getByText(NODE_META.end.label, { exact: true }).elements()).toHaveLength(0);

		const set = screen.getByTitle(NODE_META.set.description);
		await set.click();
		expect(onaddnode).toHaveBeenLastCalledWith('set');

		(set.element() as HTMLElement).focus();
		await userEvent.keyboard('{Enter}');
		expect(onaddnode).toHaveBeenCalledTimes(2);

		const dataTransfer = new DataTransfer();
		set.element().dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
		expect(dataTransfer.getData('application/workflow-node-type')).toBe('set');
	});

	it('collapses and expands', async () => {
		const ontoggle = vi.fn();
		const open = render(NodePalette, { onaddnode: () => {}, ontoggle });
		await open.getByTitle('Collapse palette').click();
		expect(ontoggle).toHaveBeenCalledOnce();
		open.unmount();

		const closed = render(NodePalette, { onaddnode: () => {}, ontoggle, open: false });
		await closed.getByTitle('Expand palette').click();
		expect(ontoggle).toHaveBeenCalledTimes(2);
	});
});
