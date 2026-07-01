<script lang="ts">
	import { onMount } from 'svelte';
	import { Moon, Sun } from '@lucide/svelte';
	import { getCurrentTheme, toggleTheme } from '$lib/utils/theme';

	let isDark = $state(false);

	onMount(() => {
		isDark = getCurrentTheme() === 'dark';
	});

	function handleToggle() {
		const next = toggleTheme();
		isDark = next === 'dark';
	}
</script>

<button
	class="btn btn-ghost btn-sm btn-circle"
	onclick={handleToggle}
	title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
>
	{#if isDark}
		<Sun size={16} />
	{:else}
		<Moon size={16} />
	{/if}
</button>
