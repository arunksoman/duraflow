<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Check, Copy } from '@lucide/svelte';
	import JsonTree from './JsonTree.svelte';
	import type { ValueChangeKind } from '$lib/zigflow-engine/runState';

	/** A titled JSON value with a tree/raw toggle and a copy button — one per input, output, state. */

	interface Props {
		title: string;
		value: unknown;
		/** Shown instead of the value when it's `undefined`. */
		emptyText?: string;
		changes?: Map<string, ValueChangeKind>;
		expandDepth?: number;
		actions?: Snippet;
	}

	let {
		title,
		value,
		emptyText = 'Nothing recorded',
		changes,
		expandDepth = 2,
		actions
	}: Props = $props();

	let raw = $state(false);
	let copied = $state(false);

	const text = $derived.by(() => {
		if (value === undefined) return '';
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	});

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard can be unavailable (insecure context); the raw view is still selectable.
		}
	}
</script>

<section class="border-base-300 bg-base-100 flex min-h-0 flex-col rounded-lg border">
	<header class="border-base-300 flex items-center gap-2 border-b px-2 py-1">
		<h4 class="text-base-content/60 text-[10px] font-semibold tracking-wider uppercase">{title}</h4>
		{@render actions?.()}
		<div class="ml-auto flex items-center gap-0.5">
			{#if value !== undefined}
				<button
					type="button"
					class="btn btn-ghost btn-xs"
					class:btn-active={raw}
					onclick={() => (raw = !raw)}
					title={raw ? 'Show as tree' : 'Show raw JSON'}
				>
					{raw ? 'Tree' : 'Raw'}
				</button>
				<button
					type="button"
					class="btn btn-ghost btn-xs btn-square"
					onclick={copy}
					title="Copy JSON"
				>
					{#if copied}<Check size={12} />{:else}<Copy size={12} />{/if}
				</button>
			{/if}
		</div>
	</header>
	<div class="min-h-0 flex-1 overflow-auto p-2">
		{#if value === undefined}
			<p class="text-base-content/40 text-xs italic">{emptyText}</p>
		{:else if raw}
			<pre class="text-xs break-all whitespace-pre-wrap">{text}</pre>
		{:else}
			<JsonTree {value} {changes} {expandDepth} />
		{/if}
	</div>
</section>
