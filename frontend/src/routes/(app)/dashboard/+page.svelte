<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { ArrowRight, FolderKanban, Plus, Search, Workflow } from '@lucide/svelte';
	import { relativeTime } from '$lib/utils/time';
	import { tintFor } from '$lib/utils/tint';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let search = $state('');
	let dialogEl: HTMLDialogElement | undefined;
	let creating = $state(false);

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
				<li>
					<a
						href={resolve('/(app)/projects/[projectId]', { projectId: project.id })}
						class="group bg-base-100 border-base-300 hover:border-primary/40 focus-visible:ring-primary/50 flex h-full flex-col gap-3 rounded-2xl border p-5 outline-none transition hover:shadow-md focus-visible:ring-2"
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
								<h2 class="truncate font-semibold">{project.name}</h2>
								<p
									class="mt-0.5 line-clamp-2 text-sm {project.description
										? 'text-base-content/60'
										: 'text-base-content/35 italic'}"
								>
									{project.description || 'No description'}
								</p>
							</div>
							<ArrowRight
								size={16}
								class="text-base-content/30 group-hover:text-primary mt-1 shrink-0 transition group-hover:translate-x-0.5"
							/>
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
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

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
