<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import JsonTree from './JsonTree.svelte';
	import type { ValueChangeKind } from '$lib/zigflow-engine/runState';

	/**
	 * Collapsible, read-only JSON viewer. Objects and arrays open to `expandDepth` levels; anything
	 * deeper starts folded so a large payload stays scannable. `changes` highlights paths a task
	 * added or changed (as produced by `diffValues`), which is how the inspector shows the variables
	 * a node touched in context rather than as a separate list.
	 */

	interface Props {
		value: unknown;
		/** Key or index shown before the value; omitted at the root. */
		name?: string;
		/** Dotted path of this value, matching `ValueChange.path`. */
		path?: string;
		depth?: number;
		expandDepth?: number;
		changes?: Map<string, ValueChangeKind>;
	}

	let { value, name, path = '', depth = 0, expandDepth = 2, changes }: Props = $props();

	const isArray = $derived(Array.isArray(value));
	const isObject = $derived(typeof value === 'object' && value !== null);
	const entries = $derived.by((): [string, unknown, string][] => {
		if (Array.isArray(value)) {
			return value.map((item, i) => [String(i), item, `${path}[${i}]`]);
		}
		if (typeof value === 'object' && value !== null) {
			return Object.entries(value).map(([key, item]) => [key, item, path ? `${path}.${key}` : key]);
		}
		return [];
	});

	// Open state is the viewer's own after the first render; it deliberately doesn't follow
	// `expandDepth` changes, which would fold things the user just opened.
	let userOpen = $state<boolean | null>(null);
	const open = $derived(userOpen ?? depth < expandDepth);

	const change = $derived(changes?.get(path));
	const containsChange = $derived.by(() => {
		if (!changes || !isObject) return false;
		for (const key of changes.keys()) {
			if (key !== path && (path === '' || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)))
				return true;
		}
		return false;
	});

	function scalarClass(v: unknown): string {
		if (v === null) return 'text-base-content/40';
		switch (typeof v) {
			case 'string':
				return 'text-success';
			case 'number':
				return 'text-info';
			case 'boolean':
				return 'text-warning';
			default:
				return 'text-base-content/60';
		}
	}

	function scalarText(v: unknown): string {
		if (v === undefined) return 'undefined';
		if (typeof v === 'string') return JSON.stringify(v);
		return String(v);
	}

	const summary = $derived(isArray ? `[${entries.length}]` : `{${entries.length}}`);
</script>

<div
	class="font-mono text-xs leading-5"
	class:json-added={change === 'added'}
	class:json-changed={change === 'changed'}
>
	{#if isObject}
		<button
			type="button"
			class="hover:bg-base-200 inline-flex max-w-full items-center gap-0.5 rounded px-0.5 text-left"
			onclick={() => (userOpen = !open)}
			aria-expanded={open}
		>
			<ChevronRight size={12} class="shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
			{#if name !== undefined}<span class="text-base-content/70">{name}:</span>{/if}
			<span class="text-base-content/40">{summary}</span>
			{#if !open && containsChange}
				<span class="bg-warning ml-1 inline-block size-1.5 rounded-full" title="Contains changes"
				></span>
			{/if}
		</button>
		{#if open}
			<div class="border-base-300 ml-1.5 border-l pl-2">
				{#each entries as [key, item, childPath] (childPath)}
					<JsonTree
						value={item}
						name={key}
						path={childPath}
						depth={depth + 1}
						{expandDepth}
						{changes}
					/>
				{:else}
					<span class="text-base-content/40">empty</span>
				{/each}
			</div>
		{/if}
	{:else}
		<div class="flex items-start gap-1 px-0.5 pl-4">
			{#if name !== undefined}<span class="text-base-content/70 shrink-0">{name}:</span>{/if}
			<span class="break-all whitespace-pre-wrap {scalarClass(value)}">{scalarText(value)}</span>
		</div>
	{/if}
</div>

<style>
	.json-added {
		background: color-mix(in oklab, var(--color-success) 14%, transparent);
		border-radius: 0.25rem;
	}
	.json-changed {
		background: color-mix(in oklab, var(--color-warning) 18%, transparent);
		border-radius: 0.25rem;
	}
</style>
