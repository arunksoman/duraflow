<script lang="ts">
	import { enhance } from '$app/forms';
	import { dev } from '$app/environment';
	import { Eye, EyeOff, FlaskConical, Lock, Mail, LoaderCircle, Workflow } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();

	let loading = $state(false);
	let showPassword = $state(false);
</script>

<svelte:head>
	<title>Log in · DuraFlow</title>
</svelte:head>

<div class="bg-base-200 flex min-h-screen items-center justify-center px-4">
	<div class="card bg-base-100 w-full max-w-sm shadow-sm">
		<div class="card-body">
			<div class="mb-2 flex flex-col items-center gap-2">
				<div class="bg-primary/10 text-primary rounded-lg p-2">
					<Workflow size={28} />
				</div>
				<h1 class="text-xl font-semibold">Sign in to DuraFlow</h1>
				<p class="text-base-content/60 text-sm">Build and run durable workflows</p>
			</div>

			<form
				method="POST"
				action="?/login"
				class="flex flex-col gap-4"
				use:enhance={() => {
					loading = true;
					return async ({ update }) => {
						await update();
						loading = false;
					};
				}}
			>
				{#if form?.error}
					<div class="alert alert-error py-2 text-sm">
						<span>{form.error}</span>
					</div>
				{/if}

				<div class="flex flex-col gap-1">
					<span class="text-sm font-medium">Email</span>
					<label class="input w-full">
						<Mail size={16} class="text-base-content/50" />
						<input
							type="email"
							name="email"
							placeholder="you@company.com"
							value={form?.email ?? ''}
							autocomplete="email"
							required
						/>
					</label>
				</div>

				<div class="flex flex-col gap-1">
					<span class="text-sm font-medium">Password</span>
					<label class="input w-full">
						<Lock size={16} class="text-base-content/50" />
						<input
							type={showPassword ? 'text' : 'password'}
							name="password"
							placeholder="••••••••"
							autocomplete="current-password"
							required
						/>
						<button
							type="button"
							class="text-base-content/50 hover:text-base-content"
							onclick={() => (showPassword = !showPassword)}
							aria-label={showPassword ? 'Hide password' : 'Show password'}
						>
							{#if showPassword}
								<EyeOff size={16} />
							{:else}
								<Eye size={16} />
							{/if}
						</button>
					</label>
				</div>

				<button type="submit" class="btn btn-primary mt-2" disabled={loading}>
					{#if loading}
						<LoaderCircle size={16} class="animate-spin" />
					{/if}
					Log in
				</button>
			</form>

			{#if dev}
				<div class="divider text-base-content/40 text-xs">no backend yet?</div>
				<form method="POST" action="?/devBypass">
					<button type="submit" class="btn btn-ghost btn-sm w-full">
						<FlaskConical size={14} />
						Continue as demo user (dev only)
					</button>
				</form>
			{/if}
		</div>
	</div>
</div>
