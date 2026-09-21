<script lang="ts">
	import { CirclePlay, Plus, Trash2 } from '@lucide/svelte';
	import type { VarEntry } from './builderConfig';

	/**
	 * Asks for a named workflow's name and parameters the moment another Start is dropped.
	 *
	 * The name is not decoration: it is the task key the workflow is saved under
	 * (`processElectronicOrder: do: [...]`), the Temporal workflow type zigflow registers it as, and
	 * what a switch case's `then:` starts it by — so it has to be unique across the document.
	 *
	 * Parameters are what this workflow starts with: they become a leading `init: set:` in its
	 * `do:`, exactly like the primary workflow's Start variables. A switch starts a named workflow
	 * with the caller's state, so a value like `${ $data.orderId }` reads what the caller had.
	 */
	interface Props {
		/** Names already used by other named workflows in this document. */
		taken: string[];
		onconfirm: (name: string, variables: VarEntry[]) => void;
		oncancel: () => void;
	}

	let { taken, onconfirm, oncancel }: Props = $props();

	// Mounted fresh per drop, so it starts empty and there is nothing to keep in sync.
	let name = $state('');
	let params = $state<VarEntry[]>([]);
	const trimmed = $derived(name.trim());
	const duplicate = $derived(taken.includes(trimmed));

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!trimmed || duplicate) return;
		onconfirm(
			trimmed,
			params.filter((p) => p.key.trim()).map((p) => ({ key: p.key.trim(), value: p.value }))
		);
	}
</script>

<div class="modal modal-open z-50">
	<div class="modal-box w-full max-w-md">
		<div class="mb-3 flex items-center gap-2">
			<div class="rounded p-1" style="background:#22c55e1a;color:#22c55e">
				<CirclePlay size={15} />
			</div>
			<div>
				<h3 class="text-sm font-semibold">New named workflow</h3>
				<p class="text-base-content/40 text-[10px]">
					Saved as <span class="font-mono">{trimmed || 'name'}: do:</span> — start it from a switch case.
				</p>
			</div>
		</div>

		<form onsubmit={submit} class="flex flex-col gap-3">
			<div class="flex flex-col gap-1">
				<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="wf-name"
					>Workflow name</label
				>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					id="wf-name"
					class="input input-sm w-full font-mono"
					class:input-error={duplicate}
					placeholder="processElectronicOrder"
					autofocus
					bind:value={name}
					onkeydown={(e) => e.key === 'Escape' && oncancel()}
				/>
				{#if duplicate}
					<p class="text-error text-[10px]">
						Another workflow in this document already has this name.
					</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1.5">
				<div class="flex items-center justify-between">
					<span class="text-base-content/50 text-[10px] font-semibold uppercase">Parameters</span>
					<button
						type="button"
						class="btn btn-ghost btn-xs text-primary gap-1"
						onclick={() => (params = [...params, { key: '', value: '' }])}
						><Plus size={12} />Add</button
					>
				</div>
				{#if params.length === 0}
					<p class="text-base-content/30 text-[10px]">
						None — the workflow sees the caller's <span class="font-mono">$input</span> and
						<span class="font-mono">$data</span> as they are.
					</p>
				{:else}
					{#each params as p, i (i)}
						<div class="flex items-center gap-1.5">
							<input
								class="input input-xs w-32 shrink-0 font-mono"
								placeholder="name"
								bind:value={p.key}
								aria-label="Parameter name"
							/>
							<input
								class="input input-xs min-w-0 flex-1 font-mono"
								placeholder={'${ $data.orderId }'}
								bind:value={p.value}
								aria-label="Parameter value"
							/>
							<button
								type="button"
								class="btn btn-ghost btn-xs btn-circle text-error shrink-0"
								onclick={() => (params = params.filter((_, j) => j !== i))}
								aria-label="Remove parameter"
							>
								<Trash2 size={13} />
							</button>
						</div>
					{/each}
					<p class="text-base-content/30 text-[9px]">
						Readable inside this workflow as <span class="font-mono">{'${ $data.<name> }'}</span>.
					</p>
				{/if}
			</div>

			<div class="modal-action mt-1">
				<button type="button" class="btn btn-ghost btn-sm" onclick={oncancel}>Cancel</button>
				<button type="submit" class="btn btn-primary btn-sm" disabled={!trimmed || duplicate}
					>Add</button
				>
			</div>
		</form>
	</div>
	<button class="modal-backdrop" onclick={oncancel} aria-label="Cancel"></button>
</div>
