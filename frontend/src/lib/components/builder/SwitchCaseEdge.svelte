<script lang="ts">
	import { BaseEdge } from '@xyflow/svelte';
	import type { EdgeProps } from '@xyflow/svelte';

	let {
		id,
		sourceX,
		sourceY,
		targetX,
		targetY,
		style,
		label,
		labelStyle,
		markerStart,
		markerEnd,
		interactionWidth,
		data
	}: EdgeProps = $props();

	/**
	 * A switch case jumps to a sibling several rows down the same column, so a normal
	 * bottom-to-top bezier would be a near-straight line drawn straight through every node in
	 * between. These swing out to the left instead — away from the main chain and away from the
	 * inline lanes (`for`/`try`/`fork` bodies), which always grow to the right. `bow` is how far
	 * out, set per case by `computeSwitchCaseEdges` so one switch's cases nest rather than overlap.
	 */
	const bow = $derived(Number((data as Record<string, unknown> | undefined)?.bow ?? 72));

	/** Vertical lead-in/out, so the curve leaves and enters the handles roughly head-on. */
	const LEAD = 26;

	const c1x = $derived(sourceX - bow);
	const c1y = $derived(sourceY + LEAD);
	const c2x = $derived(targetX - bow);
	const c2y = $derived(targetY - LEAD);

	const path = $derived(
		`M ${sourceX},${sourceY} C ${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`
	);

	// Midpoint of the cubic (t = 0.5) — where the label sits, out on the bow rather than on top of
	// the column of nodes the edge is routing around.
	const labelX = $derived((sourceX + 3 * c1x + 3 * c2x + targetX) / 8);
	const labelY = $derived((sourceY + 3 * c1y + 3 * c2y + targetY) / 8);
</script>

<BaseEdge
	{id}
	{path}
	{labelX}
	{labelY}
	{style}
	{label}
	{labelStyle}
	{markerStart}
	{markerEnd}
	{interactionWidth}
/>
