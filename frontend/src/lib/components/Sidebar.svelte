<script lang="ts">
	import { page } from '$app/state';
	import { CalendarClock, LayoutDashboard, ListChecks, Server, Workflow } from '@lucide/svelte';

	const navItems = [
		{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, enabled: true },
		{ href: '/workers', label: 'Workers', icon: Server, enabled: false },
		{ href: '/schedules', label: 'Schedules', icon: CalendarClock, enabled: false },
		{ href: '/executions', label: 'Executions', icon: ListChecks, enabled: false }
	];
</script>

<aside class="bg-base-100 border-base-300 flex w-60 shrink-0 flex-col border-r">
	<div class="flex items-center gap-2 px-5 py-4">
		<div class="bg-primary/10 text-primary rounded-lg p-1.5">
			<Workflow size={20} />
		</div>
		<span class="text-lg font-semibold">DuraFlow</span>
	</div>

	<nav class="flex flex-col gap-1 px-3">
		{#each navItems as item (item.href)}
			{@const Icon = item.icon}
			{@const active = page.url.pathname === item.href}
			{#if item.enabled}
				<a
					href={item.href}
					class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium {active
						? 'bg-primary/10 text-primary'
						: 'text-base-content/70 hover:bg-base-200'}"
				>
					<Icon size={18} />
					{item.label}
				</a>
			{:else}
				<span
					class="text-base-content/40 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium"
				>
					<Icon size={18} />
					{item.label}
					<span class="badge badge-ghost badge-xs ml-auto">soon</span>
				</span>
			{/if}
		{/each}
	</nav>
</aside>
