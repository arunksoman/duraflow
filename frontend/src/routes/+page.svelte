<script lang="ts">
	import {
		ArrowRight,
		BookOpen,
		CheckCircle2,
		FileDown,
		GitBranch,
		GitFork,
		History,
		PlayCircle,
		Repeat,
		Server,
		ShieldCheck,
		Sparkles,
		Users,
		Workflow
	} from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const flowSteps = [
		{ icon: PlayCircle, label: 'Start' },
		{ icon: GitFork, label: 'Branch' },
		{ icon: Repeat, label: 'Loop' },
		{ icon: ShieldCheck, label: 'Validate' },
		{ icon: CheckCircle2, label: 'Done' }
	];

	const features = [
		{
			icon: Workflow,
			title: 'Visual canvas',
			description:
				'Drag Task, Switch, Fork, Try, Wait, and more onto an infinite canvas powered by SvelteFlow.'
		},
		{
			icon: GitBranch,
			title: 'Hierarchical workflows',
			description:
				'Compose child workflows and jump between parent and child executions without losing context.'
		},
		{
			icon: FileDown,
			title: 'Import & export',
			description:
				'Move entire workflow trees in and out as plain YAML, ready to live in version control.'
		},
		{
			icon: Users,
			title: 'Role-based access',
			description: 'Designers build, business users watch dashboards, admins keep the lights on.'
		},
		{
			icon: History,
			title: 'Execution history',
			description: 'Inspect every run, drill into child workflows, and replay inputs and outputs.'
		},
		{
			icon: Server,
			title: 'Workers & schedules',
			description: 'Monitor worker health and manage cron-based schedules from one place.'
		}
	];
</script>

<svelte:head>
	<title>DuraFlow — Visual durable workflow builder</title>
</svelte:head>

<div class="bg-base-100 min-h-screen">
	<header class="bg-base-100/80 border-base-300 sticky top-0 z-10 border-b backdrop-blur">
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
			<div class="flex items-center gap-2">
				<div class="bg-primary/10 text-primary rounded-lg p-1.5">
					<Workflow size={20} />
				</div>
				<span class="text-lg font-semibold">DuraFlow</span>
			</div>
			<nav class="flex items-center gap-2">
				<a href="/docs" class="btn btn-ghost btn-sm">
					<BookOpen size={16} />
					Docs
				</a>
				{#if data.loggedIn}
					<a href="/dashboard" class="btn btn-primary btn-sm">Go to dashboard</a>
				{:else}
					<a href="/login" class="btn btn-primary btn-sm">Sign in</a>
				{/if}
			</nav>
		</div>
	</header>

	<section class="mx-auto max-w-4xl px-6 py-20 text-center">
		<div class="badge badge-soft badge-primary mb-5 gap-1.5 py-3">
			<Sparkles size={14} />
			Built on Temporal.io with the Zigflow DSL
		</div>

		<h1 class="text-4xl font-bold tracking-tight sm:text-5xl">
			Design durable workflows.<br /> Visually.
		</h1>

		<p class="text-base-content/60 mx-auto mt-5 max-w-2xl text-lg">
			DuraFlow is a visual workflow builder for teams running durable, long-lived processes. Compose
			nodes on a canvas, ship them as code, and watch every execution from one place.
		</p>

		<div class="mt-8 flex items-center justify-center gap-3">
			<a href={data.loggedIn ? '/dashboard' : '/login'} class="btn btn-primary">
				Get started
				<ArrowRight size={16} />
			</a>
			<a href="/docs" class="btn btn-ghost">
				<BookOpen size={16} />
				View docs
			</a>
		</div>

		<div
			class="border-base-300 mt-14 overflow-x-auto rounded-2xl border p-8"
			style="background-image: radial-gradient(circle, var(--color-base-300) 1px, transparent 1px); background-size: 18px 18px;"
		>
			<div class="flex min-w-max items-center justify-center gap-3">
				{#each flowSteps as step, i (step.label)}
					{@const Icon = step.icon}
					<div class="flex flex-col items-center gap-2">
						<div
							class="bg-base-100 border-base-300 text-primary flex size-14 items-center justify-center rounded-xl border shadow-sm"
						>
							<Icon size={22} />
						</div>
						<span class="text-base-content/60 text-xs font-medium">{step.label}</span>
					</div>
					{#if i < flowSteps.length - 1}
						<ArrowRight size={18} class="text-base-content/30 mb-5" />
					{/if}
				{/each}
			</div>
		</div>
	</section>

	<section class="bg-base-200 py-20">
		<div class="mx-auto max-w-6xl px-6">
			<div class="mx-auto max-w-2xl text-center">
				<h2 class="text-3xl font-bold tracking-tight">Everything a workflow team needs</h2>
				<p class="text-base-content/60 mt-3">
					From the first node you drag to the thousandth execution you inspect.
				</p>
			</div>

			<div class="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
				{#each features as feature (feature.title)}
					{@const Icon = feature.icon}
					<div class="card bg-base-100 border-base-300 border shadow-sm">
						<div class="card-body gap-2">
							<div
								class="bg-primary/10 text-primary mb-1 flex size-10 items-center justify-center rounded-lg"
							>
								<Icon size={20} />
							</div>
							<h3 class="card-title text-base">{feature.title}</h3>
							<p class="text-base-content/60 text-sm">{feature.description}</p>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<footer class="border-base-300 border-t py-10">
		<div
			class="text-base-content/50 mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 text-sm sm:flex-row"
		>
			<span>© 2026 DuraFlow. Built with SvelteKit and the Zigflow DSL.</span>
			<a href="/docs" class="link link-hover">Documentation</a>
		</div>
	</footer>
</div>
