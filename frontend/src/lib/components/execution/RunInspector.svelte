<script module lang="ts">
	export interface RunSelection {
		nodeId: string;
		attemptIndex: number;
	}
</script>

<script lang="ts">
	import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink } from '@lucide/svelte';
	import JsonPanel from './JsonPanel.svelte';
	import type { RunSession } from '$lib/runtime/runSession.svelte';
	import {
		diffValues,
		workflowVariables,
		type NodeRunState,
		type ValueChangeKind
	} from '$lib/zigflow-engine/runState';

	/**
	 * What one node received, returned and changed — for the attempt the user picked. With nothing
	 * selected it shows the run as a whole: the workflow's `$input` and final output.
	 */

	interface Props {
		session: RunSession;
		selection: RunSelection | null;
		labelOf: (nodeId: string) => string;
		onselect: (selection: RunSelection | null) => void;
	}

	let { session, selection, labelOf, onselect }: Props = $props();

	let tab = $state<'data' | 'variables'>('data');

	const detail = $derived(selection ? session.run.byNode[selection.nodeId] : undefined);
	const attempt = $derived(
		selection && detail
			? detail.history[Math.min(selection.attemptIndex, detail.history.length - 1)]
			: undefined
	);
	const attemptPosition = $derived(
		selection && detail ? Math.min(selection.attemptIndex, detail.history.length - 1) : 0
	);

	const variablesBefore = $derived(attempt ? workflowVariables(attempt.stateBefore) : undefined);
	const variablesAfter = $derived(attempt ? workflowVariables(attempt.stateAfter) : undefined);

	const variableChanges = $derived(
		variablesBefore !== undefined && variablesAfter !== undefined
			? diffValues(variablesBefore, variablesAfter)
			: []
	);
	const changeMap = $derived(
		new Map<string, ValueChangeKind>(variableChanges.map((c) => [c.path, c.kind]))
	);

	const stateBadge: Record<NodeRunState, string> = {
		pending: 'badge-ghost',
		running: 'badge-info',
		success: 'badge-success',
		error: 'badge-error',
		skipped: 'badge-ghost',
		unknown: 'badge-warning'
	};

	const kindClass: Record<ValueChangeKind, string> = {
		added: 'badge-success',
		changed: 'badge-warning',
		removed: 'badge-error'
	};

	function duration(startedAt?: string, endedAt?: string): string {
		if (!startedAt || !endedAt) return '';
		const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
	}

	function preview(value: unknown): string {
		if (value === undefined) return '—';
		let text: string;
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
		return text.length > 80 ? `${text.slice(0, 77)}…` : text;
	}

	function step(delta: number) {
		if (!selection || !detail) return;
		const next = attemptPosition + delta;
		if (next < 0 || next >= detail.history.length) return;
		onselect({ nodeId: selection.nodeId, attemptIndex: next });
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if !selection}
		<div class="border-base-300 border-b px-3 py-2">
			<h3 class="text-sm font-semibold">Workflow</h3>
			<p class="text-base-content/50 text-xs">
				Pick a step, or click a node on the canvas, to see what it received and returned.
			</p>
		</div>
		<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
			{#if session.error}
				<div class="alert alert-error gap-2 py-2 text-xs">
					<AlertTriangle size={14} />
					<span class="wrap-break-word whitespace-pre-wrap">{session.error}</span>
				</div>
			{/if}
			<JsonPanel title="Workflow input ($input)" value={session.run.workflowInput} />
			<JsonPanel
				title="Workflow output"
				value={session.run.workflowOutput}
				emptyText={session.status === 'running' || session.status === 'starting'
					? 'Available once the run finishes'
					: 'No output recorded'}
			/>
		</div>
	{:else}
		<div class="border-base-300 flex flex-col gap-1.5 border-b px-3 py-2">
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="btn btn-ghost btn-xs btn-square"
					onclick={() => onselect(null)}
					title="Back to the workflow"
				>
					<ChevronLeft size={14} />
				</button>
				<h3 class="min-w-0 flex-1 truncate text-sm font-semibold" title={labelOf(selection.nodeId)}>
					{labelOf(selection.nodeId)}
				</h3>
				{#if detail}
					<span class="badge badge-sm {stateBadge[attempt?.state ?? detail.state]}">
						{attempt?.state ?? detail.state}
					</span>
				{/if}
			</div>

			{#if detail && detail.history.length > 0}
				<div class="text-base-content/60 flex flex-wrap items-center gap-2 text-xs">
					{#if detail.history.length > 1}
						<div class="join">
							<button
								type="button"
								class="btn btn-xs join-item"
								disabled={attemptPosition === 0}
								onclick={() => step(-1)}
								aria-label="Previous attempt"
							>
								<ChevronLeft size={12} />
							</button>
							<span class="btn btn-xs join-item pointer-events-none">
								Run {attemptPosition + 1} of {detail.history.length}
							</span>
							<button
								type="button"
								class="btn btn-xs join-item"
								disabled={attemptPosition === detail.history.length - 1}
								onclick={() => step(1)}
								aria-label="Next attempt"
							>
								<ChevronRight size={12} />
							</button>
						</div>
					{/if}
					{#if attempt?.scopePath}
						<span title="Where this ran">{attempt.scopeLabel}</span>
					{/if}
					{#if attempt?.retry && attempt.retry > 1}
						<span class="badge badge-ghost badge-xs">retry {attempt.retry}</span>
					{/if}
					{#if duration(attempt?.startedAt, attempt?.endedAt)}
						<span>{duration(attempt?.startedAt, attempt?.endedAt)}</span>
					{/if}
					{#if detail.childExecutionId}
						<a
							class="link link-hover inline-flex items-center gap-1"
							href="/executions/{detail.childExecutionId}"
							target="_blank"
							rel="noopener"
						>
							Child run <ExternalLink size={11} />
						</a>
					{/if}
				</div>

				<div role="tablist" class="tabs tabs-box tabs-xs">
					<button
						role="tab"
						class="tab"
						class:tab-active={tab === 'data'}
						onclick={() => (tab = 'data')}
					>
						Input / Output
					</button>
					<button
						role="tab"
						class="tab"
						class:tab-active={tab === 'variables'}
						onclick={() => (tab = 'variables')}
					>
						Variables
						{#if variableChanges.length > 0}
							<span class="badge badge-warning badge-xs ml-1">{variableChanges.length}</span>
						{/if}
					</button>
				</div>
			{/if}
		</div>

		<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
			{#if !detail || detail.history.length === 0}
				<p class="text-base-content/50 py-6 text-center text-xs">
					{#if detail?.state === 'skipped'}
						This node didn't run — the workflow took a different path.
					{:else if session.status === 'running' || session.status === 'starting'}
						This node hasn't run yet.
					{:else if session.status === 'idle'}
						Run the workflow to see what this node receives and returns.
					{:else}
						No record of this node running.
					{/if}
				</p>
			{:else if attempt}
				{#if attempt.error}
					<div class="alert alert-error gap-2 py-2 text-xs">
						<AlertTriangle size={14} class="shrink-0" />
						<span class="wrap-break-word whitespace-pre-wrap">{attempt.error}</span>
					</div>
				{/if}
				{#if attempt.truncated}
					<div class="alert alert-warning py-1.5 text-xs">
						<span>Payload was too large and was truncated when recorded.</span>
					</div>
				{/if}

				{#if tab === 'data'}
					<JsonPanel title="Input" value={attempt.input} />
					<JsonPanel
						title="Output"
						value={attempt.output}
						emptyText={attempt.state === 'running' ? 'Still running…' : 'No output recorded'}
					/>
				{:else}
					{#if attempt.stateBefore === undefined && attempt.stateAfter === undefined}
						<p class="text-base-content/50 py-6 text-center text-xs">
							No workflow state was recorded for this task.
						</p>
					{:else}
						<section class="border-base-300 rounded-lg border">
							<header class="border-base-300 border-b px-2 py-1">
								<h4 class="text-base-content/60 text-[10px] font-semibold tracking-wider uppercase">
									Changed by this task
								</h4>
							</header>
							{#if attempt.stateAfter === undefined}
								<p class="text-base-content/40 p-2 text-xs italic">
									{attempt.state === 'running'
										? 'Still running…'
										: 'The task ended without a final state.'}
								</p>
							{:else if variableChanges.length === 0}
								<p class="text-base-content/40 p-2 text-xs italic">No variables changed.</p>
							{:else}
								<ul class="divide-base-300 divide-y">
									{#each variableChanges as change (change.path)}
										<li class="flex flex-col gap-0.5 px-2 py-1.5 font-mono text-xs">
											<div class="flex items-center gap-1.5">
												<span class="badge badge-xs {kindClass[change.kind]}">{change.kind}</span>
												<span class="truncate font-medium" title={change.path}
													>{change.path || '(root)'}</span
												>
											</div>
											<div class="text-base-content/60 flex flex-wrap items-center gap-1 break-all">
												{#if change.kind !== 'added'}
													<span class="line-through opacity-70">{preview(change.before)}</span>
												{/if}
												{#if change.kind === 'changed'}<span>→</span>{/if}
												{#if change.kind !== 'removed'}
													<span class="text-base-content">{preview(change.after)}</span>
												{/if}
											</div>
										</li>
									{/each}
								</ul>
							{/if}
						</section>

						<JsonPanel
							title={variablesAfter !== undefined ? 'Variables after' : 'Variables before'}
							value={variablesAfter ?? variablesBefore}
							changes={variablesAfter !== undefined ? changeMap : undefined}
						/>
						{#if variablesAfter !== undefined && variablesBefore !== undefined}
							<details>
								<summary class="text-base-content/50 cursor-pointer text-xs">
									Variables before
								</summary>
								<div class="mt-2">
									<JsonPanel title="Variables before" value={variablesBefore} />
								</div>
							</details>
						{/if}
						<details>
							<summary class="text-base-content/50 cursor-pointer text-xs">
								Raw workflow state (incl. runtime metadata)
							</summary>
							<div class="mt-2">
								<JsonPanel
									title="Raw state"
									value={attempt.stateAfter ?? attempt.stateBefore}
									expandDepth={1}
								/>
							</div>
						</details>
					{/if}
				{/if}
			{/if}
		</div>
	{/if}
</div>
