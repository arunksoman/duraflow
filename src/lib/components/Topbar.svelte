<script lang="ts">
	import { LogOut } from '@lucide/svelte';
	import type { User } from '$lib/types';

	let { user }: { user: User } = $props();
</script>

<header class="bg-base-100 border-base-300 flex items-center justify-between border-b px-6 py-3">
	<h1 class="text-lg font-semibold">Dashboard</h1>

	<div class="flex items-center gap-3">
		<div class="text-right leading-tight">
			<p class="text-sm font-medium">{user.name}</p>
			<p class="text-base-content/50 text-xs capitalize">{user.role}</p>
		</div>
		<div class="avatar avatar-placeholder">
			<div class="bg-primary text-primary-content w-8 rounded-full">
				<span class="text-sm">{user.name.slice(0, 1).toUpperCase()}</span>
			</div>
		</div>
		<form method="POST" action="/logout">
			<button class="btn btn-ghost btn-sm btn-circle" type="submit" aria-label="Log out">
				<LogOut size={16} />
			</button>
		</form>
	</div>
</header>
