<script lang="ts">
	import { BaseEdge, EdgeReconnectAnchor, getBezierPath } from '@xyflow/svelte';
	import type { EdgeProps } from '@xyflow/svelte';

	let {
		id,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		style,
		label,
		labelStyle,
		markerStart,
		markerEnd,
		interactionWidth,
		data
	}: EdgeProps = $props();

	const edgePath = $derived(
		getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
	);

	// Synthetic "try"/"catch" labeled edges (see inlineTryView.ts) are computed fresh on every
	// render, not stored — they must never be draggable-to-reconnect, since that would let a user
	// "detach" a try/catch body from its try node in a way the DSL can't represent. `deletable`/
	// `selectable: false` (set on the edge itself) already block delete/select; reconnect isn't a
	// per-edge field on this xyflow version, so it's blocked here instead by simply not rendering
	// the reconnect anchors for tagged edges.
	const isSynthetic = $derived(
		Boolean((data as Record<string, unknown> | undefined)?.syntheticTryEdge)
	);
</script>

{#if !isSynthetic}
	<EdgeReconnectAnchor type="source" />
{/if}
<BaseEdge
	{id}
	path={edgePath[0]}
	labelX={edgePath[1]}
	labelY={edgePath[2]}
	{style}
	{label}
	{labelStyle}
	{markerStart}
	{markerEnd}
	{interactionWidth}
/>
{#if !isSynthetic}
	<EdgeReconnectAnchor type="target" />
{/if}
