<script lang="ts">
	import { enhance } from '$app/forms';
	import { CalendarClock, Plus, Trash2 } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let dialogEl: HTMLDialogElement | undefined;
	let creating = $state(false);

	function dialogRef(node: HTMLDialogElement) {
		dialogEl = node;
	}
</script>

<svelte:head>
	<title>Schedules · DuraFlow</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-xl font-semibold">Schedules</h1>
			<p class="text-base-content/60 mt-1 text-sm">Recurring cron triggers across all workflows.</p>
		</div>
		<button
			class="btn btn-primary"
			disabled={data.workflows.length === 0}
			onclick={() => dialogEl?.showModal()}
		>
			<Plus size={16} />
			New Schedule
		</button>
	</div>

	{#if data.apiError}
		<div class="alert alert-warning text-sm"><span>Couldn't reach the schedules API.</span></div>
	{/if}

	{#if data.schedules.length === 0}
		<div class="text-base-content/50 flex flex-col items-center gap-2 py-20">
			<CalendarClock size={40} />
			<p>No schedules yet.</p>
		</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="table">
				<thead>
					<tr>
						<th>Workflow</th>
						<th>Cron</th>
						<th>Timezone</th>
						<th>Next run</th>
						<th>Enabled</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.schedules as schedule (schedule.id)}
						<tr>
							<td>
								<div class="font-medium">{schedule.workflowName}</div>
								<div class="text-base-content/50 text-xs">{schedule.projectName}</div>
							</td>
							<td class="font-mono text-xs">{schedule.cron}</td>
							<td class="text-xs">{schedule.timezone}</td>
							<td class="text-base-content/60 text-xs">
								{schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '—'}
							</td>
							<td>
								<form method="POST" action="?/toggle" use:enhance>
									<input type="hidden" name="id" value={schedule.id} />
									<input type="hidden" name="enabled" value={schedule.enabled} />
									<button
										type="submit"
										class="toggle toggle-sm"
										class:toggle-success={schedule.enabled}
										aria-label="Toggle schedule"
									></button>
								</form>
							</td>
							<td>
								<form method="POST" action="?/delete" use:enhance>
									<input type="hidden" name="id" value={schedule.id} />
									<button type="submit" class="btn btn-ghost btn-sm text-error" title="Delete schedule">
										<Trash2 size={14} />
									</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<dialog {@attach dialogRef} class="modal">
	<div class="modal-box">
		<h3 class="text-lg font-semibold">New schedule</h3>

		<form
			method="POST"
			action="?/create"
			class="mt-4 flex flex-col gap-3"
			use:enhance={() => {
				creating = true;
				return async ({ result, update }) => {
					creating = false;
					if (result.type === 'success') dialogEl?.close();
					await update();
				};
			}}
		>
			{#if form?.error}
				<div class="alert alert-error py-2 text-sm"><span>{form.error}</span></div>
			{/if}

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Workflow</span>
				<select name="workflowId" class="select w-full" required>
					<option value="" disabled selected>Choose a workflow…</option>
					{#each data.workflows as workflow (workflow.id)}
						<option value={workflow.id}>{workflow.projectName} / {workflow.name}</option>
					{/each}
				</select>
			</label>

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Cron expression</span>
				<input
					name="cron"
					class="input w-full font-mono"
					value={form?.cron ?? ''}
					placeholder="0 * * * *"
					required
				/>
			</label>

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Timezone (optional)</span>
				<input
					name="timezone"
					class="input w-full"
					value={form?.timezone ?? ''}
					placeholder="UTC"
				/>
			</label>

			<label class="fieldset-label flex items-center gap-2">
				<input type="checkbox" name="enabled" class="checkbox checkbox-sm" checked />
				<span class="text-sm font-medium">Enabled</span>
			</label>

			<div class="modal-action">
				<button type="button" class="btn" onclick={() => dialogEl?.close()}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={creating}>
					{creating ? 'Creating…' : 'Create schedule'}
				</button>
			</div>
		</form>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button>close</button>
	</form>
</dialog>
