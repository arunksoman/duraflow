import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Node } from '@xyflow/svelte';
import type { WorkflowMeta } from '$lib/types';
import DeleteRunsDialog from './execution/DeleteRunsDialog.svelte';
import WorkflowNameDialog from './builder/WorkflowNameDialog.svelte';
import SwitchCaseDialog from './builder/SwitchCaseDialog.svelte';
import type { CaseEntry } from './builder/builderConfig';

describe('DeleteRunsDialog', () => {
	const hidden = (form: Element, name: string) =>
		[...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

	it('confirms deleting one finished run', async () => {
		const onclose = vi.fn();
		const screen = render(DeleteRunsDialog, {
			action: '?/delete',
			ids: ['e1'],
			running: 0,
			onclose
		});
		await expect.element(screen.getByText('Delete this run?')).toBeVisible();
		const submit = screen.getByRole('button', { name: 'Delete', exact: true });
		const form = submit.element().closest('form')!;
		expect(form.getAttribute('action')).toBe('?/delete');
		expect(hidden(form, 'ids')).toEqual(['e1']);
		expect(hidden(form, 'force')).toEqual(['false']);

		await screen.getByRole('button', { name: 'Cancel' }).first().click();
		expect(onclose).toHaveBeenCalledOnce();
	});

	it('warns that running runs will be terminated, and shows errors', async () => {
		const screen = render(DeleteRunsDialog, {
			action: '?/delete',
			ids: ['a', 'b', 'c'],
			running: 2,
			error: 'run is still in progress',
			onclose: () => {}
		});
		await expect.element(screen.getByText('Delete 3 runs?')).toBeVisible();
		await expect.element(screen.getByText(/2 of these runs are/)).toBeVisible();
		await expect.element(screen.getByText('run is still in progress')).toBeVisible();
		const submit = screen.getByRole('button', { name: 'Terminate and delete' });
		const form = submit.element().closest('form')!;
		expect(hidden(form, 'ids')).toEqual(['a', 'b', 'c']);
		expect(hidden(form, 'force')).toEqual(['true']);
	});

	it('words a single running run', async () => {
		const screen = render(DeleteRunsDialog, {
			action: '?/delete',
			ids: ['a'],
			running: 1,
			onclose: () => {}
		});
		await expect.element(screen.getByText(/This run is/)).toBeVisible();
	});
});

describe('WorkflowNameDialog', () => {
	it('confirms a unique name with its trimmed parameters', async () => {
		const onconfirm = vi.fn();
		const screen = render(WorkflowNameDialog, {
			taken: ['existing'],
			onconfirm,
			oncancel: () => {}
		});
		const add = screen.getByRole('button', { name: 'Add', exact: true }).last();
		await expect.element(add).toBeDisabled();

		await screen.getByLabelText('Workflow name').fill('  approveOrder ');
		await expect.element(screen.getByText('approveOrder: do:')).toBeVisible();

		await screen.getByRole('button', { name: 'Add', exact: true }).first().click(); // add a parameter
		await screen.getByRole('button', { name: 'Add', exact: true }).first().click();
		const names = screen.getByLabelText('Parameter name');
		const values = screen.getByLabelText('Parameter value');
		await names.nth(0).fill(' orderId ');
		await values.nth(0).fill('${ $data.id }');
		// The second one is left blank and dropped; remove-then-readd exercises the delete button.
		await screen.getByLabelText('Remove parameter').nth(1).click();
		await screen.getByRole('button', { name: 'Add', exact: true }).first().click();

		await add.click();
		expect(onconfirm).toHaveBeenCalledWith('approveOrder', [
			{ key: 'orderId', value: '${ $data.id }' }
		]);
	});

	it('refuses a duplicate name and cancels on Escape or backdrop', async () => {
		const onconfirm = vi.fn();
		const oncancel = vi.fn();
		const screen = render(WorkflowNameDialog, { taken: ['existing'], onconfirm, oncancel });
		const input = screen.getByLabelText('Workflow name');
		await input.fill('existing');
		await expect.element(screen.getByText(/already has this name/)).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Add', exact: true }).last())
			.toBeDisabled();
		await userEvent.keyboard('{Enter}');
		expect(onconfirm).not.toHaveBeenCalled();

		await input.click();
		await userEvent.keyboard('{Escape}');
		expect(oncancel).toHaveBeenCalledTimes(1);
		await screen.getByRole('button', { name: 'Cancel' }).first().click();
		expect(oncancel).toHaveBeenCalledTimes(2);
	});
});

/** The <select> offering an option with this value — the condition builder renders selects too. */
function selectHolding(value: string): HTMLSelectElement {
	const match = [...document.querySelectorAll('select')].find((s) =>
		[...s.options].some((o) => o.value === value)
	);
	if (!match) throw new Error(`no select offers ${value}`);
	return match;
}

describe('SwitchCaseDialog', () => {
	const node = (id: string, type: string, data: Record<string, unknown> = {}) =>
		({ id, type, data, position: { x: 0, y: 0 } }) as Node;
	const switchNode = node('sw', 'switch', { label: 'route', cases: [] });
	const nodes = [node('start', 'start'), node('wf-a', 'start', { label: 'approve' }), switchNode];

	function setup(caseEntry: CaseEntry, extra: { isNew?: boolean; nodes?: Node[] } = {}) {
		const onchange = vi.fn();
		const ondelete = vi.fn();
		const onclose = vi.fn();
		const screen = render(SwitchCaseDialog, {
			switchNode,
			caseEntry,
			nodes: extra.nodes ?? nodes,
			edges: [],
			workflowMeta: {} as WorkflowMeta,
			isNew: extra.isNew,
			onchange,
			ondelete,
			onclose
		});
		return { screen, onchange, ondelete, onclose };
	}

	it('edits an existing case', async () => {
		const { screen, onchange, ondelete, onclose } = setup({
			id: 'c',
			name: 'big',
			condition: '${ .total > 100 }',
			routing: 'task',
			targetNodeId: 'wf-a'
		});
		await expect.element(screen.getByText('Edit case')).toBeVisible();
		await expect.element(screen.getByText('route')).toBeVisible();
		await expect.element(screen.getByText(/first match wins/)).toBeVisible();
		await expect.element(screen.getByText(/Runs a named workflow/)).toBeVisible();

		await screen.getByPlaceholder('electronic').fill('huge');
		expect(onchange).toHaveBeenLastCalledWith({ name: 'huge' });

		await userEvent.selectOptions(selectHolding('wf-a'), 'wf-a');
		expect(onchange).toHaveBeenLastCalledWith({ targetNodeId: 'wf-a' });

		await userEvent.selectOptions(selectHolding('end'), 'end');
		expect(onchange).toHaveBeenLastCalledWith({ routing: 'end' });

		await screen.getByRole('button', { name: 'Delete case' }).click();
		expect(ondelete).toHaveBeenCalledOnce();
		await screen.getByRole('button', { name: 'Done' }).click();
		expect(onclose).toHaveBeenCalledOnce();
	});

	it('defaults a new jump to the first workflow', async () => {
		const { screen, onchange } = setup(
			{ id: 'c', name: '', condition: '', routing: 'continue' },
			{ isNew: true }
		);
		await expect.element(screen.getByText('New case')).toBeVisible();
		await expect.element(screen.getByText(/matches anything that reaches it/)).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Discard' })).toBeVisible();
		await expect.element(screen.getByText(/Skips the switch/)).toBeVisible();

		await userEvent.selectOptions(selectHolding('task'), 'task');
		expect(onchange).toHaveBeenLastCalledWith({ routing: 'task', targetNodeId: 'wf-a' });
	});

	it('cannot start a workflow when there is none', async () => {
		const { screen } = setup(
			{ id: 'c', name: '', condition: '', routing: 'exit' },
			{ nodes: [node('start', 'start'), switchNode] }
		);
		const option = screen.getByRole('option', { name: 'Start workflow…' });
		await expect.element(option).toBeDisabled();
		await expect.element(screen.getByText(/Stops the task list/)).toBeVisible();
	});
});
