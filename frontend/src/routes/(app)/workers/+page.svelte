<script lang="ts">
	import { Server } from '@lucide/svelte';
	import type { PageProps } from './$types';
	import type { WorkerStatus } from '$lib/types';

	let { data }: PageProps = $props();

	const statusClass: Record<WorkerStatus, string> = {
		online: 'badge-success',
		offline: 'badge-neutral',
		draining: 'badge-warning'
	};
</script>

<svelte:head>
	<title>Workers · DuraFlow</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-xl font-semibold">Workers</h1>
		<p class="text-base-content/60 mt-1 text-sm">
			Zigflow worker processes registered against Temporal — one per workflow with a saved DSL.
		</p>
	</div>

	{#if data.apiError}
		<div class="alert alert-warning text-sm">
			<span>Couldn't reach the workers API.</span>
		</div>
	{/if}

	{#if data.workers.length === 0}
		<div class="text-base-content/50 flex flex-col items-center gap-2 py-20">
			<Server size={40} />
			<p>No workers registered yet — save a workflow with a valid DSL to start one.</p>
		</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="table">
				<thead>
					<tr>
						<th>Identity</th>
						<th>Task queue</th>
						<th>Status</th>
						<th>Last heartbeat</th>
					</tr>
				</thead>
				<tbody>
					{#each data.workers as worker (worker.id)}
						<tr>
							<td class="font-medium">{worker.identity}</td>
							<td class="font-mono text-xs">{worker.taskQueue}</td>
							<td><span class="badge {statusClass[worker.status]} badge-sm">{worker.status}</span></td>
							<td class="text-base-content/60 text-xs"
								>{new Date(worker.lastHeartbeatAt).toLocaleString()}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
