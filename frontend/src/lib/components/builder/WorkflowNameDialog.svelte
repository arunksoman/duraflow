<script lang="ts">
	import { CirclePlay } from '@lucide/svelte';

	/**
	 * Asks for a workflow's name the moment a Start is dropped. The name is not decoration: a
	 * root-level `do:` task is a whole Temporal workflow, and its task key is the workflow's type
	 * name (`processElectronicOrder: do: [...]`) — what a switch case jumps at, and what zigflow
	 * registers a worker for. Leaving it as "Workflow" would put something on screen that no longer
	 * matches what gets saved.
	 */
	interface Props {
		onconfirm: (name: string) => void;
		oncancel: () => void;
	}

	let { onconfirm, oncancel }: Props = $props();

	// Mounted fresh per drop, so it starts empty and there is nothing to keep in sync.
	let name = $state('');
	const trimmed = $derived(name.trim());

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (trimmed) onconfirm(trimmed);
	}
</script>

<div class="modal modal-open z-50">
	<div class="modal-box w-full max-w-sm">
		<div class="mb-3 flex items-center gap-2">
			<div class="rounded p-1" style="background:#22c55e1a;color:#22c55e">
				<CirclePlay size={15} />
			</div>
			<div>
				<h3 class="text-sm font-semibold">Name this workflow</h3>
				<p class="text-base-content/40 text-[10px]">
					Its steps are drawn inside a frame with this name, and saved as
					<span class="font-mono">{trimmed || 'name'}: do:</span>
				</p>
			</div>
		</div>

		<form onsubmit={submit}>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="input input-sm w-full font-mono"
				placeholder="processElectronicOrder"
				autofocus
				bind:value={name}
				onkeydown={(e) => e.key === 'Escape' && oncancel()}
			/>

			<div class="modal-action mt-4">
				<button type="button" class="btn btn-ghost btn-sm" onclick={oncancel}>Cancel</button>
				<button type="submit" class="btn btn-primary btn-sm" disabled={!trimmed}>Add</button>
			</div>
		</form>
	</div>
	<button class="modal-backdrop" onclick={oncancel} aria-label="Cancel"></button>
</div>
