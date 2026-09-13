<script lang="ts">
	import {
		CircleCheck,
		CircleDashed,
		CircleHelp,
		CircleX,
		ExternalLink,
		LoaderCircle,
		TriangleAlert
	} from '@lucide/svelte';
	import type { RunSession } from '$lib/runtime/runSession.svelte';
	import type { RunIndex } from '$lib/zigflow-engine/runIndex';
	import { buildRunSteps, type NodeAttempt } from '$lib/zigflow-engine/runState';
	import type { ExecutionStatus } from '$lib/types';
	import type { RunSelection } from './RunInspector.svelte';

	/**
	 * The path a run took, one row per executed node in the order it ran — replacing the raw event
	 * log. Loop iterations and retries appear as separate rows. Once the run has finished, nodes it
	 * never reached are listed separately, since "didn't run" is as informative as "ran".
	 */

	interface Props {
		session: RunSession;
		index: RunIndex;
		selection: RunSelection | null;
		labelOf: (nodeId: string) => string;
		onselect: (selection: RunSelection) => void;
	}

	let { session, index, selection, labelOf, onselect }: Props = $props();

	const steps = $derived(buildRunSteps(session.run));
	const skipped = $derived(
		session.run.finalized
			? Object.entries(session.run.byNode)
					.filter(([, detail]) => detail.state === 'skipped')
					.map(([nodeId]) => nodeId)
			: []
	);
	const counts = $derived({
		success: steps.filter((s) => s.attempt.state === 'success').length,
		error: steps.filter((s) => s.attempt.state === 'error').length
	});

	const childStatusClass: Record<ExecutionStatus, string> = {
		running: 'badge-info',
		completed: 'badge-success',
		failed: 'badge-error',
		cancelled: 'badge-warning',
		terminated: 'badge-warning',
		timed_out: 'badge-error'
	};

	function duration(attempt: NodeAttempt): string {
		if (!attempt.startedAt || !attempt.endedAt) return '';
		const ms = new Date(attempt.endedAt).getTime() - new Date(attempt.startedAt).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
	}

	function isSelected(nodeId: string, attemptIndex: number): boolean {
		return selection?.nodeId === nodeId && selection.attemptIndex === attemptIndex;
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="border-base-300 flex items-center gap-2 border-b px-3 py-2">
		<h3 class="text-sm font-semibold">Steps</h3>
		{#if steps.length > 0}
			<span class="text-base-content/50 text-xs">
				{counts.success} ok{#if counts.error > 0}
					· <span class="text-error">{counts.error} failed</span>{/if}
				{#if session.run.finalized && skipped.length > 0}· {skipped.length} not on path{/if}
			</span>
		{/if}
		{#if session.connected}
			<span class="text-info ml-auto flex items-center gap-1 text-[10px] uppercase">
				<span class="bg-info inline-block size-1.5 animate-pulse rounded-full"></span> live
			</span>
		{/if}
	</div>

	{#if session.run.unmatched.length > 0 || index.ambiguousScopes.size > 0}
		<div class="alert alert-warning mx-2 mt-2 gap-1.5 px-2 py-1.5 text-[11px]">
			<TriangleAlert size={12} class="shrink-0" />
			<span>
				{#if session.run.unmatched.length > 0}
					{session.run.unmatched.length} event(s) matched no node ({[
						...new Set(session.run.unmatched.map((u) => u.taskName))
					]
						.slice(0, 3)
						.join(', ')}).
				{/if}
				{#if index.ambiguousScopes.size > 0}
					Sibling loops/try blocks in one scope can't be told apart — highlighting there may be
					approximate.
				{/if}
			</span>
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-auto py-1">
		{#if steps.length === 0}
			<p class="text-base-content/50 px-3 py-6 text-center text-xs">
				{#if session.status === 'starting'}
					Starting the run…
				{:else if session.status === 'running'}
					Waiting for the first task…
				{:else if session.status === 'idle'}
					Steps appear here as each task runs.
				{:else}
					No task ran.
				{/if}
			</p>
		{:else}
			<ol>
				{#each steps as { nodeId, attemptIndex, attempt } (`${nodeId}:${attemptIndex}`)}
					{@const total = session.run.byNode[nodeId]?.history.length ?? 1}
					<li>
						<button
							type="button"
							class="hover:bg-base-200 flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
							class:step-selected={isSelected(nodeId, attemptIndex)}
							onclick={() => onselect({ nodeId, attemptIndex })}
						>
							{#if attempt.state === 'success'}
								<CircleCheck size={14} class="text-success shrink-0" />
							{:else if attempt.state === 'error'}
								<CircleX size={14} class="text-error shrink-0" />
							{:else if attempt.state === 'running'}
								<LoaderCircle size={14} class="text-info shrink-0 animate-spin" />
							{:else}
								<CircleHelp size={14} class="text-warning shrink-0" />
							{/if}
							<span class="min-w-0 flex-1">
								<span class="block truncate font-medium">{labelOf(nodeId)}</span>
								{#if attempt.scopePath || total > 1}
									<span class="text-base-content/50 block truncate text-[10px]">
										{#if total > 1}#{attemptIndex + 1}{/if}
										{#if attempt.scopePath}{attempt.scopeLabel}{/if}
									</span>
								{/if}
								{#if attempt.error}
									<span class="text-error block truncate text-[10px]" title={attempt.error}>
										{attempt.error}
									</span>
								{/if}
							</span>
							<span class="text-base-content/40 shrink-0 text-[10px]">{duration(attempt)}</span>
						</button>
					</li>
				{/each}
			</ol>
		{/if}

		{#if skipped.length > 0}
			<details class="border-base-300 mt-1 border-t">
				<summary class="text-base-content/50 cursor-pointer px-3 py-1.5 text-xs">
					Not on path ({skipped.length})
				</summary>
				<ul>
					{#each skipped as nodeId (nodeId)}
						<li>
							<button
								type="button"
								class="hover:bg-base-200 text-base-content/50 flex w-full items-center gap-2 px-3 py-1 text-left text-xs"
								onclick={() => onselect({ nodeId, attemptIndex: 0 })}
							>
								<CircleDashed size={14} class="shrink-0" />
								<span class="truncate">{labelOf(nodeId)}</span>
							</button>
						</li>
					{/each}
				</ul>
			</details>
		{/if}

		{#if session.childRuns.length > 0}
			<div class="border-base-300 mt-1 border-t px-3 py-2">
				<p class="text-base-content/50 mb-1 text-[10px] font-semibold tracking-wider uppercase">
					Child runs
				</p>
				<ul class="flex flex-col gap-1">
					{#each session.childRuns as child (child.id)}
						<li class="flex items-center gap-2 text-xs">
							<span class="badge badge-xs {childStatusClass[child.status]}">{child.status}</span>
							<span class="min-w-0 flex-1 truncate">
								{child.workflowName || child.workflowType || child.id.slice(0, 8)}
								{#if child.parentTaskName}
									<span class="text-base-content/50">· {child.parentTaskName}</span>
								{/if}
							</span>
							<a
								class="link link-hover inline-flex items-center"
								href="/executions/{child.id}"
								target="_blank"
								rel="noopener"
								aria-label="Open child run"
							>
								<ExternalLink size={12} />
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
</div>

<style>
	.step-selected {
		background: color-mix(in oklab, var(--color-primary) 12%, transparent);
	}
</style>
