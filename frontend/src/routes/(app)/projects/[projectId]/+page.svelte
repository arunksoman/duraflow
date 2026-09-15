<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		ArrowLeft,
		EllipsisVertical,
		History,
		PenSquare,
		Plus,
		Trash2,
		Workflow as WorkflowIcon
	} from '@lucide/svelte';
	import type { ExecutionStatus, Workflow } from '$lib/types';
	import { relativeTime } from '$lib/utils/time';
	import { tintFor } from '$lib/utils/tint';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let dialogEl: HTMLDialogElement | undefined;
	let creating = $state(false);
	let pendingDelete = $state<Workflow | null>(null);
	let deleting = $state(false);

	function dialogRef(node: HTMLDialogElement) {
		dialogEl = node;
	}

	const STATUS: Record<ExecutionStatus, { label: string; dot: string }> = {
		running: { label: 'Running', dot: 'bg-info animate-pulse' },
		completed: { label: 'Succeeded', dot: 'bg-success' },
		failed: { label: 'Failed', dot: 'bg-error' },
		cancelled: { label: 'Cancelled', dot: 'bg-warning' },
		terminated: { label: 'Terminated', dot: 'bg-warning' },
		timed_out: { label: 'Timed out', dot: 'bg-error' }
	};

	/** Focus-driven daisyUI dropdowns stay open until focus leaves them. */
	function closeMenu() {
		(document.activeElement as HTMLElement | null)?.blur();
	}

	function builderHref(workflow: Workflow) {
		return resolve('/(app)/projects/[projectId]/workflows/[workflowId]/builder', {
			projectId: data.project.id,
			workflowId: workflow.id
		});
	}
</script>

<svelte:head>
	<title>{data.project.name} · DuraFlow</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if data.apiError}
		<div class="alert alert-warning text-sm">
			<span>Couldn't reach the workflow API — showing no workflows yet.</span>
		</div>
	{/if}

	<div class="flex flex-wrap items-end justify-between gap-3">
		<div class="min-w-0">
			<a
				href={resolve('/dashboard')}
				class="text-base-content/50 hover:text-base-content mb-2 inline-flex items-center gap-1 text-xs transition"
			>
				<ArrowLeft size={12} />
				All projects
			</a>
			<h1 class="text-xl font-semibold">{data.project.name}</h1>
			<p class="text-base-content/60 mt-0.5 text-sm">
				{[
					data.project.description,
					`${data.workflows.length} workflow${data.workflows.length === 1 ? '' : 's'}`
				]
					.filter(Boolean)
					.join(' · ')}
			</p>
		</div>

		<button class="btn btn-primary" onclick={() => dialogEl?.showModal()}>
			<Plus size={16} />
			New workflow
		</button>
	</div>

	{#if data.workflows.length === 0}
		<div
			class="border-base-300 text-base-content/60 flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16"
		>
			<WorkflowIcon size={36} class="text-base-content/40" />
			<p class="text-sm">No workflows in this project yet.</p>
			<button class="btn btn-primary btn-sm" onclick={() => dialogEl?.showModal()}>
				<Plus size={14} />
				Create your first workflow
			</button>
		</div>
	{:else}
		<ul class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{#each data.workflows as workflow (workflow.id)}
				{@const lastRun = data.lastRuns[workflow.id]}
				{@const draft = !workflow.dsl?.trim()}
				<li
					class="group bg-base-100 border-base-300 hover:border-primary/40 has-[a:focus-visible]:ring-primary/50 relative flex flex-col gap-3 rounded-2xl border p-5 transition hover:shadow-md has-[a:focus-visible]:ring-2"
				>
					<div class="flex items-start gap-3">
						<span
							class="flex size-10 shrink-0 items-center justify-center rounded-xl {tintFor(
								workflow.id
							)}"
						>
							<WorkflowIcon size={18} />
						</span>
						<div class="min-w-0 flex-1">
							<!-- Stretched link: the whole card opens the builder. -->
							<a
								href={builderHref(workflow)}
								class="block truncate font-semibold outline-none after:absolute after:inset-0 after:rounded-2xl"
							>
								{workflow.name}
							</a>
							<p
								class="mt-0.5 line-clamp-2 text-sm {workflow.description
									? 'text-base-content/60'
									: 'text-base-content/35 italic'}"
							>
								{workflow.description || 'No description'}
							</p>
						</div>

						<!-- Sits above the stretched link so it stays clickable. -->
						<div class="dropdown dropdown-end relative z-10 -mt-1 -mr-2">
							<div
								tabindex="0"
								role="button"
								class="btn btn-ghost btn-sm btn-square text-base-content/50 hover:text-base-content"
								aria-label="Actions for {workflow.name}"
								aria-haspopup="menu"
							>
								<EllipsisVertical size={16} />
							</div>
							<ul
								tabindex="-1"
								class="dropdown-content menu bg-base-100 rounded-box border-base-300 z-20 mt-1 w-44 border p-1 shadow-lg"
								role="menu"
							>
								<li role="none">
									<a role="menuitem" href={builderHref(workflow)}>
										<PenSquare size={14} /> Open builder
									</a>
								</li>
								<li role="none">
									<a
										role="menuitem"
										href="{resolve('/executions')}?workflowId={encodeURIComponent(workflow.id)}"
									>
										<History size={14} /> View runs
									</a>
								</li>
								<li role="none" class="border-base-300 my-1 border-t"></li>
								<li role="none">
									<button
										type="button"
										role="menuitem"
										class="text-error"
										onclick={() => {
											closeMenu();
											pendingDelete = workflow;
										}}
									>
										<Trash2 size={14} /> Delete
									</button>
								</li>
							</ul>
						</div>
					</div>

					<div
						class="text-base-content/55 mt-auto flex items-center justify-between gap-2 pt-1 text-xs"
					>
						<span class="flex min-w-0 items-center gap-1.5">
							{#if draft}
								<span class="badge badge-ghost badge-sm">Draft</span>
							{:else if lastRun}
								<span class="size-2 shrink-0 rounded-full {STATUS[lastRun.status].dot}"></span>
								<span class="truncate">
									<span class="text-base-content/80">{STATUS[lastRun.status].label}</span>
									· {relativeTime(lastRun.startedAt)}
								</span>
							{:else}
								<span class="bg-base-300 size-2 shrink-0 rounded-full"></span>
								<span>Never run</span>
							{/if}
						</span>
						<span class="shrink-0" title="Updated {new Date(workflow.updatedAt).toLocaleString()}">
							v{workflow.version} · edited {relativeTime(workflow.updatedAt)}
						</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#if pendingDelete}
	{@const target = pendingDelete}
	<div
		class="modal modal-open z-50"
		role="dialog"
		aria-modal="true"
		aria-labelledby="delete-workflow-title"
	>
		<div class="modal-box max-w-md">
			<h3 id="delete-workflow-title" class="text-lg font-semibold">Delete “{target.name}”?</h3>
			<p class="text-base-content/70 mt-2 text-sm">
				This deletes the workflow along with all of its runs and schedules, and stops its worker.
				Runs still in progress are terminated. This can't be undone.
			</p>

			{#if form?.deleteError}
				<div class="alert alert-error mt-3 py-2 text-sm"><span>{form.deleteError}</span></div>
			{/if}

			<form
				method="POST"
				action="?/deleteWorkflow"
				use:enhance={() => {
					deleting = true;
					return async ({ result, update }) => {
						deleting = false;
						await update();
						if (result.type === 'success') pendingDelete = null;
					};
				}}
			>
				<input type="hidden" name="id" value={target.id} />
				<div class="modal-action">
					<button
						type="button"
						class="btn"
						onclick={() => (pendingDelete = null)}
						disabled={deleting}>Cancel</button
					>
					<button type="submit" class="btn btn-error" disabled={deleting}>
						{#if deleting}<span class="loading loading-spinner loading-xs"></span>{/if}
						Delete workflow
					</button>
				</div>
			</form>
		</div>
		<button
			type="button"
			class="modal-backdrop"
			onclick={() => (pendingDelete = null)}
			aria-label="Cancel"
		></button>
	</div>
{/if}

<dialog {@attach dialogRef} class="modal">
	<div class="modal-box">
		<h3 class="text-lg font-semibold">New workflow</h3>

		<form
			method="POST"
			action="?/createWorkflow"
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
				<div class="alert alert-error py-2 text-sm">
					<span>{form.error}</span>
				</div>
			{/if}

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Name</span>
				<input
					name="name"
					class="input w-full"
					value={form?.name ?? ''}
					placeholder="Order Fulfillment"
					required
				/>
			</label>

			<label class="fieldset-label flex flex-col gap-1">
				<span class="text-sm font-medium">Description (optional)</span>
				<textarea name="description" class="textarea w-full" rows="2"
					>{form?.description ?? ''}</textarea
				>
			</label>

			<div class="modal-action">
				<button type="button" class="btn" onclick={() => dialogEl?.close()}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={creating}>
					{creating ? 'Creating…' : 'Create workflow'}
				</button>
			</div>
		</form>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button>close</button>
	</form>
</dialog>
