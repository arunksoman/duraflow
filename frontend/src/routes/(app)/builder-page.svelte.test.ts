import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { resetForms, respondWith, settled, submissions } from '$lib/testing/forms';
import type { Project, Workflow } from '$lib/types';
import { NODE_META } from '$lib/components/builder/builderConfig';
import BuilderPage from './projects/[projectId]/workflows/[workflowId]/builder/+page.svelte';

vi.mock('$app/forms', () => import('$lib/testing/forms'));
vi.mock('$app/state', () => ({
	page: {
		params: { projectId: 'p1', workflowId: 'w1' },
		url: new URL('http://app.test/projects/p1/workflows/w1/builder')
	}
}));

const DSL = `document:
  dsl: 1.0.0
  version: 0.1.0
  taskQueue: orders-q
  workflowType: orders
do:
  - prepareOrder:
      set:
        total: 1
  - notify:
      set:
        sent: true
`;

const sources: { url: string }[] = [];

beforeEach(() => {
	resetForms();
	sources.length = 0;
	vi.stubGlobal(
		'EventSource',
		class {
			constructor(readonly url: string) {
				sources.push(this);
			}
			addEventListener() {}
			close() {}
		}
	);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json([]))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** The flow canvas needs real dimensions; Tailwind's sizing classes aren't loaded in tests. */
function sizedContainer(): HTMLElement {
	const box = document.createElement('div');
	box.style.cssText = 'width: 1400px; height: 800px;';
	box.className = 'sized-box';
	document.body.appendChild(box);
	const style = document.createElement('style');
	style.textContent =
		'.sized-box>div{height:100%}.h-screen{height:800px}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.relative{position:relative}';
	box.appendChild(style);
	return box;
}

function builder(dsl = DSL) {
	const screen = render(
		BuilderPage,
		{
			data: {
				project: { id: 'p1', name: 'Billing' } as Project,
				workflow: { id: 'w1', name: 'Orders', projectId: 'p1', dsl } as Workflow,
				siblingWorkflows: []
			},
			params: { projectId: 'p1', workflowId: 'w1' }
		} as never,
		{ baseElement: sizedContainer() }
	);
	const savedDsl = async () => {
		await screen.getByRole('button', { name: 'Save' }).click();
		await settled();
		return String(submissions.at(-1)?.data.get('dsl'));
	};
	const nodeByLabel = (label: string) =>
		[...document.querySelectorAll<HTMLElement>('.svelte-flow__node')].find((n) =>
			n.textContent?.includes(label)
		);
	return { screen, savedDsl, nodeByLabel };
}

describe('builder page', () => {
	it('draws the stored DSL and saves it back unchanged in substance', async () => {
		const { screen, savedDsl, nodeByLabel } = builder();
		await expect.element(screen.getByText('Billing')).toBeVisible();
		await expect.poll(() => nodeByLabel('prepareOrder')).toBeTruthy();
		expect(nodeByLabel('notify')).toBeTruthy();

		const saved = await savedDsl();
		expect(saved).toContain('workflowType: orders');
		expect(saved).toContain('prepareOrder:');
		await expect.element(screen.getByRole('button', { name: 'Saved' })).toBeVisible();
	});

	it('starts a new workflow with a default header', async () => {
		const { savedDsl } = builder('');
		const saved = await savedDsl();
		expect(saved).toContain('workflowType: orders');
		expect(saved).toContain('taskQueue: billing');
	});

	it('adds a node from the palette', async () => {
		const { screen, savedDsl, nodeByLabel } = builder();
		await expect.poll(() => nodeByLabel('notify')).toBeTruthy();
		await screen.getByTitle(NODE_META.set.description).click();
		const saved = await savedDsl();
		expect(saved.match(/set:/g)?.length).toBe(3);
		await screen.getByTitle('Collapse palette').click();
		await expect.element(screen.getByTitle('Expand palette')).toBeVisible();
	});

	it('edits a node in the side panel', async () => {
		const { screen, savedDsl, nodeByLabel } = builder();
		await expect.poll(() => nodeByLabel('notify')).toBeTruthy();
		nodeByLabel('notify')!.click();
		const label = screen.getByLabelText('Label');
		await expect.element(label).toHaveValue('notify');
		await label.fill('notifyCustomer');
		expect(await savedDsl()).toContain('notifyCustomer:');

		await screen.getByLabelText('Close panel').click();
		expect(screen.getByLabelText('Label').elements()).toHaveLength(0);
	});

	it('edits the DSL as text and syncs it to the canvas', async () => {
		const { screen, nodeByLabel } = builder();
		await expect.poll(() => nodeByLabel('notify')).toBeTruthy();
		await screen.getByRole('button', { name: 'DSL' }).click();
		await expect.element(screen.getByText('Zigflow DSL')).toBeVisible();
		const editor = document.querySelector<HTMLElement>('.modal .cm-content')!;

		await userEvent.fill(editor, DSL.replace('notify', 'emailCustomer'));
		await expect.poll(() => nodeByLabel('emailCustomer'), { timeout: 3000 }).toBeTruthy();

		await userEvent.fill(editor, 'document: {}\ndo: nope');
		await expect
			.element(screen.getByText('Not applied to canvas — fix to resume sync'))
			.toBeVisible();

		await screen.getByRole('checkbox', { name: 'Sync to canvas' }).click();
		await userEvent.fill(editor, 'still: broken');
		expect(screen.getByText(/Not applied to canvas/).elements()).toHaveLength(0);

		await screen.getByRole('button', { name: 'Reset' }).click();
		await expect.poll(() => editor.textContent).toContain('emailCustomer');
		await screen.getByRole('button', { name: '✕' }).click();
		expect(screen.getByText('Zigflow DSL').elements()).toHaveLength(0);
	});

	it('edits workflow variables and the schedule', async () => {
		const { screen, savedDsl } = builder();
		await screen.getByRole('button', { name: 'Variables' }).click();
		await screen.getByLabelText('taskQueue').fill('other-q');
		await screen.getByRole('button', { name: 'Done' }).click();
		expect(await savedDsl()).toContain('taskQueue: other-q');

		await screen.getByRole('button', { name: /Schedule/ }).click();
		await screen.getByLabelText('Run on a schedule').click();
		await screen.getByRole('button', { name: 'Done' }).click();
		await expect.element(screen.getByLabelText('Schedule active')).toBeInTheDocument();
		expect(await savedDsl()).toMatch(/schedule:\s+cron:/);
	});

	it('saves and runs the design, then follows the run', async () => {
		const { screen } = builder();
		respondWith({ type: 'success', status: 200, data: { execution: { id: 'run-1' } } });
		await screen.getByRole('button', { name: 'Run', exact: true }).click();
		await settled();
		const posted = submissions.find((s) => s.action === '?/run')!;
		expect(posted.data.get('dsl')).toContain('prepareOrder');
		expect(posted.data.get('input')).toBe('{}');
		await expect.poll(() => sources.at(-1)?.url).toMatch(/^\/executions\/run-1\/watch/);
		await expect.element(screen.getByText('Run · Orders')).toBeVisible();

		await screen.getByLabelText('Close run window').click();
		expect(screen.getByText('Run · Orders').elements()).toHaveLength(0);
		await expect.element(screen.getByRole('button', { name: 'Running…' })).toBeVisible();
	});

	it('reports a run that fails to start', async () => {
		const { screen } = builder();
		respondWith({ type: 'failure', status: 502, data: { error: 'no worker polling' } });
		await screen.getByRole('button', { name: 'Run', exact: true }).click();
		await settled();
		await expect.element(screen.getByText('no worker polling')).toBeVisible();
		await expect.element(screen.getByText('not run yet')).toBeVisible();

		respondWith({ type: 'error', status: 500, error: new Error('x') });
		await screen.getByRole('button', { name: 'Run', exact: true }).last().click();
		await settled();
		await expect.element(screen.getByText('Failed to start the run')).toBeVisible();
	});

	it('asks for declared inputs before running', async () => {
		const withInput = DSL.replace(
			'do:',
			'input:\n  schema:\n    format: json\n    document:\n      type: object\n      required: [orderId]\n      properties:\n        orderId:\n          type: string\ndo:'
		);
		const { screen } = builder(withInput);
		await screen.getByRole('button', { name: 'Run', exact: true }).click();
		await expect.element(screen.getByText('Run inputs')).toBeVisible();
		expect(submissions.filter((s) => s.action === '?/run')).toHaveLength(0);

		// Required and blank: stays open with the error.
		await screen.getByRole('button', { name: 'Run', exact: true }).last().click();
		await expect.element(screen.getByText('Required.')).toBeVisible();

		await userEvent.fill(document.querySelector<HTMLInputElement>('#run-input-orderId')!, 'o-1');
		respondWith({ type: 'success', status: 200, data: { execution: { id: 'run-2' } } });
		await screen.getByRole('button', { name: 'Run', exact: true }).last().click();
		await settled();
		expect(JSON.parse(String(submissions.at(-1)?.data.get('input')))).toEqual({ orderId: 'o-1' });
	});

	it('draws loop bodies in titled frames and switch cases as edges into named workflows', async () => {
		const nested = `document:
  dsl: 1.0.0
  taskQueue: q
  workflowType: router
  version: 0.1.0
do:
  - eachItem:
      for:
        each: item
        in: \${ $input.items }
      do:
        - touch:
            set:
              seen: true
  - route:
      switch:
        - big:
            when: \${ $input.total > 100 }
            then: reviewOrder
        - default:
            then: continue
  - reviewOrder:
      do:
        - approve:
            set:
              ok: true
`;
		const { screen, savedDsl, nodeByLabel } = builder(nested);
		await expect.poll(() => nodeByLabel('touch')).toBeTruthy();

		// The loop body's frame is titled, and its title opens the loop's own settings.
		const frameTitle = screen.getByRole('button', { name: 'eachItem body' });
		await expect.element(frameTitle).toBeInTheDocument();
		(frameTitle.element() as HTMLElement).click();
		await expect.element(screen.getByLabelText('Label')).toHaveValue('eachItem');

		// The case that starts a named workflow is drawn as an edge into its Start.
		await expect
			.poll(() => document.querySelectorAll('.svelte-flow__edge').length)
			.toBeGreaterThan(4);
		const caseEdges = () =>
			[...document.querySelectorAll<SVGElement>('.svelte-flow__edge')].filter((e) =>
				e.getAttribute('data-id')?.startsWith('switch-case-')
			);
		await expect.poll(() => caseEdges().length).toBeGreaterThan(0);
		const caseEdge = caseEdges()[0];

		// Clicking it opens the case editor.
		caseEdge!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await expect.element(screen.getByText('Edit case')).toBeVisible();
		await screen.getByPlaceholder('electronic').fill('huge');
		await screen.getByRole('button', { name: 'Done' }).click();

		const saved = await savedDsl();
		expect(saved).toContain('huge:');
		expect(saved).toContain('then: reviewOrder');
		expect(saved).toMatch(/for:\s+each: item/);
	});

	it('adds a named workflow from the palette Start', async () => {
		const { screen, savedDsl } = builder();
		await screen.getByTitle(NODE_META.start.description).click();
		await screen.getByLabelText('Workflow name').fill('approveOrder');
		await screen.getByRole('button', { name: 'Add', exact: true }).last().click();
		await expect.element(screen.getByText('approveOrder').first()).toBeVisible();
		expect(await savedDsl()).toContain('approveOrder');
	});
});
