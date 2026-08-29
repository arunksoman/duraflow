<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronRight } from '@lucide/svelte';

	interface Props {
		title: string;
		defaultOpen?: boolean;
		children: Snippet;
	}

	let { title, defaultOpen = false, children }: Props = $props();
</script>

<details class="group border-base-200 border-b last:border-b-0" open={defaultOpen}>
	<summary
		class="text-base-content/50 marker:content-none flex cursor-pointer list-none items-center gap-1 py-2 text-[10px] font-semibold uppercase tracking-wider [&::-webkit-details-marker]:hidden"
	>
		<ChevronRight size={10} class="shrink-0 transition-transform group-open:rotate-90" />
		{title}
	</summary>
	<div class="flex flex-col gap-3 pb-3 pl-3.5">
		{@render children()}
	</div>
</details>
