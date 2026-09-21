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
	 * How far a same-column jump swings out to the left. A case that jumps to a task further down
	 * its own column would otherwise be a near-straight line drawn through every node in between, so
	 * it bows away from the chain instead; `computeSwitchCaseEdges` sets a different distance per
	 * case so one switch's jumps nest rather than overlap.
	 */
	const bow = $derived(Number((data as Record<string, unknown> | undefined)?.bow ?? 72));

	/** Narrower than one lane pitch, so only a jump staying in its own column counts as same-column. */
	const NEXT_COLUMN = 140;

	/**
	 * Where along the curve the label sits. Every case of one switch leaves the same handle, so
	 * labels parked at a fixed point would stack on top of each other — `computeSwitchCaseEdges` and
	 * `laneEntryEdge` space them out along their own curve instead.
	 */
	const labelT = $derived(Number((data as Record<string, unknown> | undefined)?.labelT ?? 0.5));

	/** Vertical lead-in/out, so the curve leaves and enters the handles roughly head-on. */
	const LEAD = 26;

	/**
	 * A jump into another column — a named workflow's Start, say — needs no bow: there is nothing
	 * between the two to draw through, and bowing left would drag the curve back across the main
	 * chain to get there. It leans towards its target instead.
	 */
	const sameColumn = $derived(Math.abs(targetX - sourceX) < NEXT_COLUMN);
	const dx = $derived(targetX - sourceX);

	const c1x = $derived(sameColumn ? sourceX - bow : sourceX + dx * 0.4);
	const c1y = $derived(sourceY + LEAD);
	const c2x = $derived(sameColumn ? targetX - bow : targetX - dx * 0.12);
	// Coming in from another column, the target is usually a workflow's Start card sitting at the
	// top of its own frame — approach from well above it so the last stretch drops in vertically
	// instead of cutting across the frame's contents.
	const c2y = $derived(
		sameColumn ? targetY - LEAD : targetY - Math.max(LEAD, Math.abs(targetY - sourceY) * 0.45)
	);

	const path = $derived(
		`M ${sourceX},${sourceY} C ${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`
	);

	/** The cubic's point at `labelT`. */
	function at(t: number, p0: number, p1: number, p2: number, p3: number): number {
		const u = 1 - t;
		return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
	}

	const labelX = $derived(at(labelT, sourceX, c1x, c2x, targetX));
	const labelY = $derived(at(labelT, sourceY, c1y, c2y, targetY));
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
