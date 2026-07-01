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
		interactionWidth
	}: EdgeProps = $props();

	const edgePath = $derived(
		getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
	);
</script>

<EdgeReconnectAnchor type="source" />
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
<EdgeReconnectAnchor type="target" />
