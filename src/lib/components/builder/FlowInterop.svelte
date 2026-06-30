<script lang="ts">
	import { onMount } from 'svelte';
	import { useSvelteFlow } from '@xyflow/svelte';

	interface Props {
		onready: (screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number }) => void;
	}

	let { onready }: Props = $props();

	const { screenToFlowPosition } = useSvelteFlow();

	onMount(() => {
		onready(screenToFlowPosition);
	});
</script>
