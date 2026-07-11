<script lang="ts">
	import { Moon, Sun } from '@lucide/svelte';
	import { getCurrentTheme, toggleTheme } from '$lib/utils/theme.svelte';

	const isDark = $derived(getCurrentTheme() === 'dark');
</script>

<button
	class="btn btn-ghost btn-sm btn-circle"
	onclick={() => toggleTheme()}
	title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
>
	{#if isDark}
		<Sun size={16} />
	{:else}
		<Moon size={16} />
	{/if}
</button>
