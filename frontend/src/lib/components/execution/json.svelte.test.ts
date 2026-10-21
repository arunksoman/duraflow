import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import JsonTree from './JsonTree.svelte';
import JsonPanel from './JsonPanel.svelte';

describe('JsonTree', () => {
	const value = {
		name: 'ada',
		count: 3,
		active: true,
		missing: null,
		tags: ['a', 'b'],
		nested: { deep: { deeper: 1 } },
		empty: {}
	};

	it('renders scalars by type and folds below expandDepth', async () => {
		const screen = render(JsonTree, { value, expandDepth: 2 });
		await expect.element(screen.getByText('"ada"')).toHaveClass('text-success');
		await expect.element(screen.getByText('3', { exact: true })).toHaveClass('text-info');
		await expect.element(screen.getByText('true')).toHaveClass('text-warning');
		await expect.element(screen.getByText('null')).toHaveClass('text-base-content/40');
		await expect.element(screen.getByText('[2]')).toBeVisible();
		await expect.element(screen.getByText('empty', { exact: true })).toBeVisible();

		// nested.deep is at depth 2: folded until opened.
		expect(screen.getByText('deeper:').elements()).toHaveLength(0);
		await screen.getByRole('button', { name: /deep:/ }).click();
		await expect.element(screen.getByText('deeper:')).toBeVisible();
		await screen.getByRole('button', { name: /deep:/ }).click();
		expect(screen.getByText('deeper:').elements()).toHaveLength(0);
	});

	it('renders a bare scalar and undefined', async () => {
		const screen = render(JsonTree, { value: undefined });
		await expect.element(screen.getByText('undefined')).toBeVisible();
	});

	it('highlights changed paths and flags folded containers holding changes', async () => {
		const changes = new Map([
			['nested.deep.deeper', 'changed' as const],
			['name', 'added' as const]
		]);
		const screen = render(JsonTree, { value, changes, expandDepth: 1 });
		expect(screen.getByText('"ada"').element().closest('.json-added')).not.toBeNull();
		await expect.element(screen.getByTitle('Contains changes')).toBeInTheDocument();
		await screen.getByRole('button', { name: /nested:/ }).click();
		await screen.getByRole('button', { name: /deep:/ }).click();
		expect(
			screen.getByText('1', { exact: true }).element().closest('.json-changed')
		).not.toBeNull();
	});
});

describe('JsonPanel', () => {
	it('shows the empty text when there is no value', async () => {
		const screen = render(JsonPanel, { title: 'Output', value: undefined, emptyText: 'No output' });
		await expect.element(screen.getByText('No output')).toBeVisible();
		expect(screen.getByRole('button', { name: 'Raw' }).elements()).toHaveLength(0);
	});

	it('switches between tree and raw JSON', async () => {
		const screen = render(JsonPanel, { title: 'Input', value: { a: 1 } });
		await expect.element(screen.getByText('Input')).toBeVisible();
		await screen.getByRole('button', { name: 'Raw' }).click();
		await expect.element(screen.getByText('"a": 1', { exact: false })).toBeVisible();
		await screen.getByRole('button', { name: 'Tree' }).click();
		await expect.element(screen.getByText('a:')).toBeVisible();
	});

	it('copies the JSON', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
		const screen = render(JsonPanel, { title: 'Output', value: [1, 2] });
		await screen.getByTitle('Copy JSON').click();
		expect(writeText).toHaveBeenCalledWith('[\n  1,\n  2\n]');
	});

	it('survives an unavailable clipboard and an unserialisable value', async () => {
		vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
			writeText: vi.fn().mockRejectedValue(new Error('denied'))
		} as never);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const screen = render(JsonPanel, { title: 'State', value: 10n as unknown });
		await screen.getByTitle('Copy JSON').click();
		await screen.getByRole('button', { name: 'Raw' }).click();
		await expect.element(screen.getByText('10')).toBeVisible();
	});
});
