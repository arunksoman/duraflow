import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import type { Node } from '@xyflow/svelte';
import type { Workflow, WorkflowMeta, WorkflowNodeType } from '$lib/types';
import { NODE_TYPES, freshNodeData, type CaseEntry } from './builderConfig';
import { OWNER_SCOPE_TAG } from '$lib/zigflow-engine/inlineScopeView';
import { workflowScopeKey } from '$lib/zigflow-engine/scopeKey';
import NodePanel from './NodePanel.svelte';

const node = (id: string, type: string, data: Record<string, unknown> = {}) =>
	({ id, type, data, position: { x: 0, y: 0 } }) as Node;

function panel(
	target: Node,
	extra: { nodes?: Node[]; meta?: Partial<WorkflowMeta>; siblings?: Workflow[] } = {}
) {
	const calls = { update: vi.fn(), meta: vi.fn(), removeBranch: vi.fn(), close: vi.fn() };
	const screen = render(NodePanel, {
		node: target,
		nodes: extra.nodes ?? [node('start', 'start'), target],
		edges: [],
		workflowMeta: { inputSchema: [], envVars: [], ...extra.meta } as WorkflowMeta,
		siblingWorkflows: extra.siblings ?? [],
		onclose: calls.close,
		onupdate: calls.update,
		onremovebranch: calls.removeBranch,
		onupdatemeta: calls.meta
	});
	const total = () => calls.update.mock.calls.length + calls.meta.mock.calls.length;
	return { screen, calls, total };
}

/** A value different from the control's current one, for a select. */
function otherOption(select: HTMLSelectElement): string | undefined {
	return [...select.options].find((o) => !o.disabled && o.value !== select.value)?.value;
}

/**
 * Touches every plain form control the panel shows for a node and returns the ones that reported
 * nothing. Chip-editor internals (ExpressionInput's "Add expression part") commit on their own
 * terms and have their own tests, so they're skipped; CodeMirror is skipped for the same reason.
 */
async function silentControls(container: HTMLElement, total: () => number): Promise<string[]> {
	for (const d of container.querySelectorAll('details')) d.open = true;
	await tick();

	const silent: string[] = [];
	const controls = [...container.querySelectorAll<HTMLElement>('input, select, textarea')].filter(
		(el) =>
			!el.closest('.cm-editor') &&
			el.getAttribute('aria-label') !== 'Add expression part' &&
			el.isConnected
	);
	for (const el of controls) {
		if (!el.isConnected) continue;
		const before = total();
		if (el instanceof HTMLSelectElement) {
			const value = otherOption(el);
			if (value === undefined) continue;
			await userEvent.selectOptions(el, value);
		} else if (el instanceof HTMLInputElement && el.type === 'radio') {
			if (el.checked) continue; // choosing the current option changes nothing
			el.click();
		} else if (el instanceof HTMLInputElement && el.type === 'checkbox') {
			el.click();
		} else {
			const input = el as HTMLInputElement;
			const value = input.type === 'number' ? '7' : 'x1';
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		}
		await tick();
		if (total() === before) {
			silent.push(
				el.getAttribute('aria-label') ||
					el.getAttribute('placeholder') ||
					el.id ||
					`${el.tagName.toLowerCase()}[${(el as HTMLInputElement).type ?? ''}]`
			);
		}
	}
	return silent;
}

describe('NodePanel', () => {
	it.each(NODE_TYPES.filter((t) => t !== 'end'))(
		'every %s control reports its change',
		async (type) => {
			const data = {
				...freshNodeData(type as WorkflowNodeType),
				label: `my ${type}`,
				variables: [{ key: 'k', value: 'v' }],
				headers: [{ key: 'h', value: 'v' }],
				query: [{ key: 'q', value: 'v' }],
				environment: [{ key: 'E', value: 'v' }],
				branches: [{ id: 'b1', name: 'left' }]
			};
			const target = node('n1', type, data);
			const { screen, total } = panel(target, {
				meta: { inputSchema: [{ name: 'f', type: 'array' }] as never }
			});
			await expect.element(screen.getByText(`my ${type}`).first()).toBeVisible();
			expect(await silentControls(screen.container as HTMLElement, total)).toEqual([]);
		}
	);

	it('shows the end node without a label field and closes', async () => {
		const { screen, calls } = panel(node('end', 'end', {}));
		expect(screen.container.querySelector('#np-label')).toBeNull();
		await screen.getByLabelText('Close panel').click();
		expect(calls.close).toHaveBeenCalled();
	});

	it('edits the variables of a set task', async () => {
		const { screen, calls } = panel(node('s', 'set', { label: 'Prepare Order', variables: [] }));
		await expect.element(screen.getByText('prepare-order')).toBeVisible();
		await expect.element(screen.getByText('No variables — click Add.')).toBeVisible();
		await screen.getByRole('button', { name: 'Add', exact: true }).click();
		expect(calls.update).toHaveBeenLastCalledWith('s', { variables: [{ key: '', value: '' }] });
		await screen.getByRole('textbox', { name: 'key', exact: true }).fill('total');
		expect(calls.update).toHaveBeenLastCalledWith('s', {
			variables: [{ key: 'total', value: '' }]
		});
		await screen.getByRole('button', { name: 'Remove', exact: true }).click();
		expect(calls.update).toHaveBeenLastCalledWith('s', { variables: [] });
	});

	it('orders, adds and removes switch cases', async () => {
		const cases: CaseEntry[] = [
			{ id: 'a', name: 'first', condition: '${ .x }', routing: 'continue' },
			{ id: 'b', name: 'second', condition: '', routing: 'end' }
		];
		const { screen, calls } = panel(node('sw', 'switch', { cases }));
		const lastCases = () => calls.update.mock.lastCall?.[1].cases as CaseEntry[];

		await expect.element(screen.getByLabelText('Move case up').first()).toBeDisabled();
		await screen.getByLabelText('Move case down').first().click();
		expect(lastCases().map((c) => c.id)).toEqual(['b', 'a']);

		await screen.getByRole('button', { name: 'Add case' }).click();
		expect(lastCases()).toHaveLength(3);
		expect(lastCases()[2]).toMatchObject({ name: 'case3', routing: 'continue' });

		await screen.getByLabelText('Remove case').first().click();
		expect(lastCases().map((c) => c.id)).toEqual(['a', lastCases()[1].id]);
	});

	it('starts a switch with a single "otherwise" case', async () => {
		const { screen } = panel(node('sw', 'switch', {}));
		await expect.element(screen.getByPlaceholder('electronic')).toHaveValue('otherwise');
	});

	it('adds and removes fork branches, telling the canvas to prune', async () => {
		const { screen, calls } = panel(node('f', 'fork', { branches: [] }));
		await expect.element(screen.getByText('No branches — click Add branch.')).toBeVisible();
		await screen.getByRole('button', { name: 'Add branch' }).click();
		const added = (calls.update.mock.lastCall?.[1].branches as { id: string; name: string }[])[0];
		expect(added.name).toBe('branch1');
		await screen.getByLabelText('Remove branch').click();
		expect(calls.removeBranch).toHaveBeenCalledWith('f', added.id);
	});

	it('edits the workflow $input schema from the primary Start', async () => {
		const { screen, calls } = panel(node('start', 'start', {}));
		await screen.getByText('$input Schema').click(); // folded while empty
		await expect.element(screen.getByText(/No input fields defined/)).toBeVisible();
		await screen.getByRole('button', { name: 'Add', exact: true }).first().click();
		expect(calls.meta).toHaveBeenLastCalledWith({ inputSchema: [{ name: '', type: 'string' }] });
		await screen.getByLabelText('Remove field').click();
		expect(calls.meta).toHaveBeenLastCalledWith({ inputSchema: [] });
	});

	it('treats another Start as a named workflow and flags it while empty', async () => {
		const named = node('wf1', 'start', { label: 'approve' });
		const empty = panel(named, { nodes: [node('start', 'start'), named] });
		await expect.element(empty.screen.getByText('Workflow name')).toBeVisible();
		await expect.element(empty.screen.getByText('Parameters', { exact: true })).toBeVisible();
		expect(empty.screen.getByText('$input Schema').elements()).toHaveLength(0);
		await expect.element(empty.screen.getByText(/No steps yet/)).toBeVisible();
		empty.screen.unmount();

		const step = node('s1', 'set', { [OWNER_SCOPE_TAG]: workflowScopeKey('wf1') });
		const filled = panel(named, { nodes: [node('start', 'start'), named, step] });
		await expect.element(filled.screen.getByText('Parameters', { exact: true })).toBeVisible();
		expect(filled.screen.getByText(/No steps yet/).elements()).toHaveLength(0);
	});

	it('offers sibling workflows with a valid DSL as child workflow targets', async () => {
		const siblings = [
			{ id: 'a', name: 'Billing', dsl: 'document:\n  taskQueue: q\n  workflowType: billing\n' },
			{ id: 'b', name: 'Draft', dsl: '' }
		] as Workflow[];
		const { screen } = panel(node('c', 'childWorkflow', {}), { siblings });
		const options = [...screen.container.querySelectorAll('option')].map((o) =>
			o.textContent?.trim()
		);
		expect(options).toContain('Billing');
		expect(options).not.toContain('Draft');
	});
});
