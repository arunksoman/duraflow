<script lang="ts">
	import { enhance } from '$app/forms';
	import { TriangleAlert } from '@lucide/svelte';

	/**
	 * Confirms a permanent delete of one or more runs, then posts `ids` (repeated) and `force` to
	 * `action`. A run still in progress can only be deleted by terminating it, so that is spelled out
	 * rather than done silently.
	 */

	interface Props {
		action: string;
		ids: string[];
		/** How many of `ids` are still running. */
		running: number;
		error?: string;
		onclose: () => void;
		/** Called after a successful delete that didn't redirect. */
		ondone?: () => void;
	}

	let { action, ids, running, error, onclose, ondone }: Props = $props();

	let submitting = $state(false);
</script>

<div
	class="modal modal-open z-50"
	role="dialog"
	aria-modal="true"
	aria-labelledby="delete-runs-title"
>
	<div class="modal-box max-w-md">
		<h3 id="delete-runs-title" class="text-lg font-semibold">
			Delete {ids.length === 1 ? 'this run' : `${ids.length} runs`}?
		</h3>
		<p class="text-base-content/70 mt-2 text-sm">
			This permanently removes {ids.length === 1 ? 'the run' : 'the runs'}, any child-workflow runs
			{ids.length === 1 ? 'it' : 'they'} started, the recorded step data, and the history in Temporal.
			It can't be undone.
		</p>

		{#if running > 0}
			<div class="alert alert-warning mt-3 gap-2 py-2 text-sm">
				<TriangleAlert size={16} class="shrink-0" />
				<span>
					{running === 1 && ids.length === 1 ? 'This run is' : `${running} of these runs are`} still in
					progress and will be terminated first.
				</span>
			</div>
		{/if}

		{#if error}
			<div class="alert alert-error mt-3 py-2 text-sm"><span>{error}</span></div>
		{/if}

		<form
			method="POST"
			{action}
			use:enhance={() => {
				submitting = true;
				return async ({ result, update }) => {
					submitting = false;
					await update();
					if (result.type === 'success') ondone?.();
				};
			}}
		>
			{#each ids as id (id)}
				<input type="hidden" name="ids" value={id} />
			{/each}
			<input type="hidden" name="force" value={running > 0 ? 'true' : 'false'} />
			<div class="modal-action">
				<button type="button" class="btn" onclick={onclose} disabled={submitting}>Cancel</button>
				<button type="submit" class="btn btn-error" disabled={submitting}>
					{#if submitting}<span class="loading loading-spinner loading-xs"></span>{/if}
					{running > 0 ? 'Terminate and delete' : 'Delete'}
				</button>
			</div>
		</form>
	</div>
	<button type="button" class="modal-backdrop" onclick={onclose} aria-label="Cancel"></button>
</div>
