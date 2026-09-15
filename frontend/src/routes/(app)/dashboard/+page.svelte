<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		EllipsisVertical,
		FolderKanban,
		FolderOpen,
		Plus,
		Search,
		Trash2,
		Workflow
	} from '@lucide/svelte';
	import { relativeTime } from '$lib/utils/time';
	import { tintFor } from '$lib/utils/tint';
	import type { Project } from '$lib/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let search = $state('');
	let dialogEl: HTMLDialogElement | undefined;
	let creating = $state(false);
	let pendingDelete = $state<Project | null>(null);
	let confirmName = $state('');
	let deleting = $state(false);

	function dialogRef(node: HTMLDialogElement) {
		dialogEl = node;
	}

	let filteredProjects = $derived(
		data.projects.filter((project) =>
			project.name.toLowerCase().includes(search.trim().toLowerCase())
		)
	);
</script>

<svelte:head>
	<title>Dashboard · DuraFlow</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if data.apiError}
		<div class="alert alert-warning text-sm">
			<span>Couldn't reach the workflow API — showing no projects yet.</span>
		</div>
	{/if}

	<div class="flex flex-wrap items-center justify-between gap-3">
		<label class="input w-full max-w-xs">
			<Search size={16} class="text-base-content/50" />
			<input type="search" placeholder="Search projects…" bind:value={search} />
		</label>

		<button class="btn btn-primary" onclick={() => dialogEl?.showModal()}>
			<Plus size={16} />
			New project
		</button>
	</div>

	{#if filteredProjects.length === 0}
		<div
			class="border-base-300 text-base-content/60 flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16"
		>
			<FolderKanban size={36} class="text-base-content/40" />
			<p class="text-sm">
				{search ? 'No projects match your search.' : 'No projects yet.'}
			</p>
			{#if !search}
				<button class="btn btn-primary btn-sm" onclick={() => dialogEl?.showModal()}>
					<Plus size={14} />
					Create your first project
				</button>
			{/if}
		</div>
	{:else}
		<ul class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{#each filteredProjects as project (project.id)}
				<li
					class="bg-base-100 border-base-300 hover:border-primary/40 has-[a:focus-visible]:ring-primary/50 relative flex flex-col gap-3 rounded-2xl border p-5 transition hover:shadow-md has-[a:focus-visible]:ring-2"
				>
					<div class="flex items-start gap-3">
						<span
							class="flex size-10 shrink-0 items-center justify-center rounded-xl text-base font-semibold uppercase {tintFor(
								project.id
							)}"
						>
							{project.name.trim().charAt(0) || '?'}
						</span>
						<div class="min-w-0 flex-1">
							<!-- Stretched link: the whole card opens the project. -->
							<a
								href={resolve('/(app)/projects/[projectId]', { projectId: project.id })}
								class="block truncate font-semibold outline-none after:absolute after:inset-0 after:rounded-2xl"
							>
								{project.name}
							</a>
							<p
								class="mt-0.5 line-clamp-2 text-sm {project.description
									? 'text-base-content/60'
									: 'text-base-content/35 italic'}"
							>
								{project.description || 'No description'}
							</p>
						</div>

						<!-- Sits above the stretched link so it stays clickable. -->
						<div class="dropdown dropdown-end relative z-10 -mt-1 -mr-2">
							<div
								tabindex="0"
								role="button"
								class="btn btn-ghost btn-sm btn-square text-base-content/50 hover:text-base-content"
								aria-label="Actions for {project.name}"
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
									<a
										role="menuitem"
										href={resolve('/(app)/projects/[projectId]', { projectId: project.id })}
									>
										<FolderOpen size={14} /> Open project
									</a>
								</li>
								<li role="none" class="border-base-300 my-1 border-t"></li>
								<li role="none">
									<button
										type="button"
										role="menuitem"
										class="text-error"
										onclick={() => {
											(document.activeElement as HTMLElement | null)?.blur();
											confirmName = '';
											pendingDelete = project;
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
						<span class="inline-flex items-center gap-1.5">
							<Workflow size={13} />
							{project.workflowCount} workflow{project.workflowCount === 1 ? '' : 's'}
						</span>
						<span title="Updated {new Date(project.updatedAt).toLocaleString()}">
							Updated {relativeTime(project.updatedAt)}
						</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#if pendingDelete}
	{@const target = pendingDelete}
	{@const needsName = target.workflowCount > 0}
	<div
		class="modal modal-open z-50"
		role="dialog"
		aria-modal="true"
		aria-labelledby="delete-project-title"
	>
		<div class="modal-box max-w-md">
			<h3 id="delete-project-title" class="text-lg font-semibold">Delete “{target.name}”?</h3>
			<p class="text-base-content/70 mt-2 text-sm">
				{#if needsName}
					This deletes the project and its {target.workflowCount}
					workflow{target.workflowCount === 1 ? '' : 's'}, along with all of their runs, schedules
					and workers. Runs still in progress are terminated. This can't be undone.
				{:else}
					The project is empty. This can't be undone.
				{/if}
			</p>

			{#if form?.deleteError}
				<div class="alert alert-error mt-3 py-2 text-sm"><span>{form.deleteError}</span></div>
			{/if}

			<form
				method="POST"
				action="?/delete"
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
				{#if needsName}
					<label class="mt-4 flex flex-col gap-1.5">
						<span class="text-sm">
							Type <span class="font-mono font-semibold">{target.name}</span> to confirm
						</span>
						<input class="input w-full" bind:value={confirmName} autocomplete="off" />
					</label>
				{/if}
				<div class="modal-action">
					<button
						type="button"
						class="btn"
						onclick={() => (pendingDelete = null)}
						disabled={deleting}>Cancel</button
					>
					<button
						type="submit"
						class="btn btn-error"
						disabled={deleting || (needsName && confirmName.trim() !== target.name.trim())}
					>
						{#if deleting}<span class="loading loading-spinner loading-xs"></span>{/if}
						Delete project
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
		<h3 class="text-lg font-semibold">New project</h3>

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
					{creating ? 'Creating…' : 'Create project'}
				</button>
			</div>
		</form>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button>close</button>
	</form>
</dialog>
