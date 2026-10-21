import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { RunSession } from '$lib/runtime/runSession.svelte';
import { event, fixtureEvents, runFixture } from '$lib/testing/runFixture';
import type { Execution, InputField } from '$lib/types';
import RunInspector from './RunInspector.svelte';
import RunWorkspace from './RunWorkspace.svelte';
import RunModal from './RunModal.svelte';

function replayed(status: Execution['status'] = 'failed', error?: string) {
	const fixture = runFixture();
	const session = new RunSession();
	session.replay({ id: 'e1', status, error } as Execution, fixture.index, fixtureEvents(), [
		{ id: 'child-run', parentTaskName: 'callChild' } as Execution
	]);
	return { ...fixture, session };
}

describe('RunInspector', () => {
	function inspector(selection: { nodeId: string; attemptIndex: number } | null) {
		const ctx = replayed('failed', 'notify failed');
		const onselect = vi.fn();
		const screen = render(RunInspector, {
			session: ctx.session,
			selection,
			labelOf: (id: string) => `label:${id}`,
			onselect
		});
		return { ...ctx, screen, onselect };
	}

	it('shows the whole run when nothing is selected', async () => {
		const { screen } = inspector(null);
		await expect.element(screen.getByText('notify failed')).toBeVisible();
		await expect.element(screen.getByText('Workflow input ($input)')).toBeVisible();
		await expect.element(screen.getByText('orderId:')).toBeVisible();
		await expect.element(screen.getByText('No output recorded')).toBeVisible();
	});

	it('steps through a node’s attempts', async () => {
		const ctx = replayed();
		const onselect = vi.fn();
		const prepare = ctx.nodeIdOf('prepare');
		const screen = render(RunInspector, {
			session: ctx.session,
			selection: { nodeId: prepare, attemptIndex: 1 },
			labelOf: () => 'Prepare',
			onselect
		});
		await expect.element(screen.getByText('Run 2 of 2')).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Next attempt' })).toBeDisabled();
		await expect.element(screen.getByText('1.00 s')).toBeVisible();

		await screen.getByRole('button', { name: 'Previous attempt' }).click();
		expect(onselect).toHaveBeenLastCalledWith({ nodeId: prepare, attemptIndex: 0 });

		await screen.getByTitle('Back to the workflow').click();
		expect(onselect).toHaveBeenLastCalledWith(null);
	});

	it('lists the variables a task changed', async () => {
		const ctx = replayed();
		const screen = render(RunInspector, {
			session: ctx.session,
			selection: { nodeId: ctx.nodeIdOf('prepare'), attemptIndex: 1 },
			labelOf: () => 'Prepare',
			onselect: () => {}
		});
		await screen.getByRole('tab', { name: /Variables/ }).click();
		await expect.element(screen.getByText('Changed by this task')).toBeVisible();
		for (const kind of ['changed', 'removed', 'added']) {
			await expect.element(screen.getByText(kind, { exact: true }).first()).toHaveClass('badge');
		}
		// Long values are previewed, not dumped.
		await expect.element(screen.getByText(/x{20,}…/)).toBeVisible();
		await screen.getByText('Raw workflow state (incl. runtime metadata)').click();
		await expect.element(screen.getByText('Raw state')).toBeVisible();

		await screen.getByRole('tab', { name: 'Input / Output' }).click();
		await expect.element(screen.getByText('Input', { exact: true })).toBeVisible();
	});

	it('reports when nothing changed, and when no state was recorded', async () => {
		const ctx = replayed();
		const first = render(RunInspector, {
			session: ctx.session,
			selection: { nodeId: ctx.nodeIdOf('prepare'), attemptIndex: 0 },
			labelOf: () => 'Prepare',
			onselect: () => {}
		});
		await first.getByRole('tab', { name: /Variables/ }).click();
		await expect.element(first.getByText('No variables changed.')).toBeVisible();
		first.unmount();

		const failed = render(RunInspector, {
			session: ctx.session,
			selection: { nodeId: ctx.nodeIdOf('notify'), attemptIndex: 0 },
			labelOf: () => 'Notify',
			onselect: () => {}
		});
		await expect.element(failed.getByText('smtp down')).toBeVisible();
		await expect.element(failed.getByText('error', { exact: true })).toHaveClass('badge-error');
		await failed.getByRole('tab', { name: /Variables/ }).click();
		await expect
			.element(failed.getByText('No workflow state was recorded for this task.'))
			.toBeVisible();
	});

	it('explains a node that didn’t run, and links a child run', async () => {
		const ctx = replayed();
		const skipped = render(RunInspector, {
			session: ctx.session,
			selection: { nodeId: ctx.nodeIdOf('archive'), attemptIndex: 0 },
			labelOf: () => 'Archive',
			onselect: () => {}
		});
		await expect
			.element(skipped.getByText(/didn't run — the workflow took a different path/))
			.toBeVisible();
		skipped.unmount();

		const idle = new RunSession();
		const notYet = render(RunInspector, {
			session: idle,
			selection: { nodeId: 'anything', attemptIndex: 0 },
			labelOf: () => 'X',
			onselect: () => {}
		});
		await expect.element(notYet.getByText(/Run the workflow to see/)).toBeVisible();
	});
});

/** SvelteFlow needs a sized box to lay out in, and Tailwind's sizing classes aren't loaded here. */
function sizedContainer(): HTMLElement {
	const box = document.createElement('div');
	box.style.cssText = 'width: 1200px; height: 700px;';
	const style = document.createElement('style');
	// render() mounts into its own container inside the box; make that fill it.
	style.textContent = '.sized-box > div { display: flex; height: 100%; }';
	box.className = 'sized-box';
	box.appendChild(style);
	document.body.appendChild(box);
	return box;
}

describe('RunWorkspace', () => {
	it('colours the canvas by run state and inspects a clicked node', async () => {
		const ctx = replayed();
		const screen = render(
			RunWorkspace,
			{ session: ctx.session, index: ctx.index, scopes: ctx.scopes },
			{ baseElement: sizedContainer() }
		);

		const nodeEl = (name: string) =>
			document.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${ctx.nodeIdOf(name)}"]`);
		await expect.poll(() => nodeEl('prepare')).not.toBeNull();
		// The event for a task that isn't on the canvas is surfaced, not dropped.
		await expect.element(screen.getByText(/1 event\(s\) matched no node \(ghost\)/)).toBeVisible();

		// Dispatched directly: the lane-frame layer sits over the nodes and takes real pointer hits.
		nodeEl('notify')!.click();
		await expect.element(screen.getByText('smtp down')).toBeVisible();

		document.querySelector<HTMLElement>('.svelte-flow__pane')!.click();
		await expect.element(screen.getByText('Workflow input ($input)')).toBeVisible();
	});

	it('explains a run with no canvas', async () => {
		const session = new RunSession();
		const screen = render(RunWorkspace, { session, index: runFixture().index, scopes: {} });
		await expect.element(screen.getByText(/No canvas for this run/)).toBeVisible();
	});
});

describe('RunModal', () => {
	function modal(
		extra: {
			fields?: InputField[];
			session?: RunSession;
			inputErrors?: Record<string, string>;
			inputJsonError?: string | null;
		} = {}
	) {
		const fixture = runFixture();
		const session = extra.session ?? new RunSession();
		const handlers = { onrun: vi.fn(), onclear: vi.fn(), onclose: vi.fn(), onjsonerror: vi.fn() };
		const screen = render(RunModal, {
			workflowName: 'orders',
			session,
			index: fixture.index,
			scopes: fixture.scopes,
			fields: extra.fields ?? [],
			input: {},
			inputErrors: extra.inputErrors ?? {},
			inputJsonError: extra.inputJsonError ?? null,
			runError: 'last run failed to start',
			canvasChanged: true,
			allRunsHref: '/executions?workflowId=w1',
			...handlers
		});
		return { screen, session, ...handlers };
	}

	it('runs straight away when the workflow declares no inputs', async () => {
		const { screen, onrun, onclose } = modal();
		await expect.element(screen.getByText('not run yet')).toBeVisible();
		await expect.element(screen.getByText('last run failed to start')).toBeVisible();
		await expect
			.element(screen.getByText(/The design changed since this run started/))
			.toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'All runs' }))
			.toHaveAttribute('href', '/executions?workflowId=w1');

		await screen.getByRole('button', { name: 'Run', exact: true }).click();
		expect(onrun).toHaveBeenCalledOnce();

		await screen.getByLabelText('Close run window').click();
		expect(onclose).toHaveBeenCalled();
	});

	it('can pass custom JSON input', async () => {
		const { screen, onrun } = modal();
		await screen.getByLabelText('Run with a custom input').click();
		await expect.element(screen.getByText('$input as JSON')).toBeVisible();
		await screen.getByRole('button', { name: 'Run', exact: true }).last().click();
		expect(onrun).toHaveBeenCalledOnce();
		expect(screen.getByText('Run inputs').elements()).toHaveLength(0);
	});

	it('asks for declared inputs first and keeps the dialog on errors', async () => {
		const fields = [{ name: 'qty', type: 'number' }] as InputField[];
		const { screen, onrun } = modal({ fields, inputErrors: { qty: 'Required.' } });
		await expect.element(screen.getByText('1 declared')).toBeVisible();
		await expect.element(screen.getByText('Fix the highlighted inputs to run.')).toBeVisible();
		await screen.getByRole('button', { name: 'Run', exact: true }).last().click();
		expect(onrun).toHaveBeenCalledOnce();
		await expect.element(screen.getByText('Run inputs')).toBeVisible();

		await screen.getByLabelText('Close inputs').click();
		expect(screen.getByText('Run inputs').elements()).toHaveLength(0);
		await screen.getByRole('button', { name: 'Run', exact: true }).click();
		await expect.element(screen.getByText('Run inputs')).toBeVisible();
		await userEvent.keyboard('{Escape}');
	});

	it('disables Run on invalid JSON input', async () => {
		const { screen } = modal({ inputJsonError: 'Not valid JSON.' });
		await screen.getByLabelText('Run with a custom input').click();
		await expect
			.element(screen.getByRole('button', { name: 'Run', exact: true }).last())
			.toBeDisabled();
		await screen.getByRole('button', { name: 'Cancel' }).click();
		expect(screen.getByText('Run inputs').elements()).toHaveLength(0);
	});

	it('shows a finished run and clears it', async () => {
		const { session } = replayed('completed');
		const { screen, onclear } = modal({ session });
		await expect
			.element(screen.getByText('completed', { exact: true }))
			.toHaveClass('badge-success');
		await expect
			.element(screen.getByRole('link', { name: 'Run page' }))
			.toHaveAttribute('href', '/executions/e1');
		await expect.element(screen.getByRole('button', { name: 'Run again' })).toBeVisible();
		await screen.getByRole('button', { name: 'Clear run' }).click();
		expect(onclear).toHaveBeenCalledOnce();
	});

	it('times a run in progress', async () => {
		const session = new RunSession();
		const { screen } = modal({ session });
		session.beginStarting(runFixture().index);
		await expect.element(screen.getByRole('button', { name: 'Running…' })).toBeDisabled();
		await expect.element(screen.getByText(/^\d+(\.\d)? m?s$/)).toBeVisible();
		session.replay(
			{ id: 'e1', status: 'failed' } as Execution,
			runFixture().index,
			[event('workflow.started', undefined, {})],
			[]
		);
		await expect.element(screen.getByText('failed', { exact: true })).toBeVisible();
	});
});
