<script lang="ts">
	import { ViewportPortal } from '@xyflow/svelte';
	import type { LaneBox } from '$lib/zigflow-engine/inlineScopeView';

	/**
	 * The titled dotted frames drawn around every inline lane, so a nested body reads as the
	 * self-contained group of tasks the DSL says it is — a switch branch is `processElectronicOrder`,
	 * not an unlabeled column of cards next to the main flow.
	 *
	 * Each frame is capped: a start marker above its first node and an end marker below its last,
	 * because a nested body runs from its first task to its last, and a frame without them gives the
	 * eye nowhere to enter or leave. A named workflow's frame has no start cap and no title — the
	 * Start card it wraps is both.
	 *
	 * Rendered into xyflow's *back* viewport portal, which means these sit behind the nodes and
	 * follow pan/zoom for free: their positions are plain flow coordinates, the same ones
	 * `computeLiveLaneBoxes` derives from where the nodes actually are.
	 *
	 * The caps are drawn here rather than added to `nodes` on purpose. They are pure display — no
	 * DSL task backs them — and a synthetic entry in the array xyflow two-way binds would have to be
	 * filtered back out of every save, delete, drag and hit-test in the builder.
	 */
	interface Props {
		boxes: LaneBox[];
		/** Clicking a frame's title opens the owning node's config. Omitted on the read-only run canvas. */
		onselect?: (nodeId: string) => void;
	}

	let { boxes, onselect }: Props = $props();

	/** Breathing room around the lane's nodes, and the strip the title sits in above them. */
	const PAD = 18;
	const TITLE_H = 26;

	/** Rendered size of a cap pill, and the clearance kept between it and the frame's edge. */
	const CAP_H = 20;
	const CAP_CLEAR = 6;

	/**
	 * The frame has to contain the caps as well as the nodes — on a lane whose own chain is shorter
	 * than the lanes nested inside it, the union-grown `yStart`/`yEnd` already reach further than the
	 * caps do, so each edge takes whichever is further out.
	 */
	function frameTop(box: LaneBox): number {
		const capTop = box.caps.showStart ? box.caps.startY - CAP_H / 2 - CAP_CLEAR : Infinity;
		return Math.min(box.yStart - PAD, capTop) - (box.title ? TITLE_H : 0);
	}

	function frameBottom(box: LaneBox): number {
		return Math.max(box.yEnd + PAD, box.caps.endY + CAP_H / 2 + CAP_CLEAR);
	}
</script>

<ViewportPortal target="back">
	{#each boxes as box (box.key)}
		{@const top = frameTop(box)}
		{@const left = box.x - PAD}
		<div
			class="lane-box"
			style:transform="translate({left}px, {top}px)"
			style:width="{box.width + PAD * 2}px"
			style:height="{frameBottom(box) - top}px"
		>
			{#if box.title}
				{#if onselect}
					<button class="lane-box-title" onclick={() => onselect?.(box.ownerNodeId)}>
						{box.title}
					</button>
				{:else}
					<span class="lane-box-title lane-box-title-static">{box.title}</span>
				{/if}
			{/if}

			<!-- Stubs first, so each cap pill paints over the end of its own line. -->
			{#if box.caps.showStart}
				<div
					class="lane-stub"
					style:left="{box.caps.x - left}px"
					style:top="{box.caps.startY + CAP_H / 2 - top}px"
					style:height="{Math.max(box.caps.chainTop - box.caps.startY - CAP_H / 2, 0)}px"
				></div>
			{/if}
			<div
				class="lane-stub"
				style:left="{box.caps.x - left}px"
				style:top="{box.caps.chainBottom - top}px"
				style:height="{Math.max(box.caps.endY - CAP_H / 2 - box.caps.chainBottom, 0)}px"
			></div>

			{#if box.caps.showStart}
				<div
					class="lane-cap lane-cap-start"
					style:left="{box.caps.x - left}px"
					style:top="{box.caps.startY - top}px"
				>
					start
				</div>
			{/if}
			<div
				class="lane-cap lane-cap-end"
				style:left="{box.caps.x - left}px"
				style:top="{box.caps.endY - top}px"
			>
				end
			</div>
		</div>
	{/each}
</ViewportPortal>

<style>
	.lane-box {
		position: absolute;
		top: 0;
		left: 0;
		border: 1px dashed var(--color-base-300);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-base-content) 3%, transparent);
		/* Pointer-transparent so the frame never steals a drag meant for the canvas underneath —
		   only the title re-enables pointer events. */
		pointer-events: none;
	}

	/* Centred, not left-aligned: the entry edge's condition label lands near the frame's top-left
	   corner, and the two were printing over each other. */
	.lane-box-title {
		position: absolute;
		top: 4px;
		left: 50%;
		transform: translateX(-50%);
		max-width: calc(100% - 20px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: inherit;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--color-base-content);
		opacity: 0.55;
		background: transparent;
		border: 0;
		padding: 0;
		pointer-events: auto;
		cursor: pointer;
	}

	.lane-box-title:hover {
		opacity: 0.9;
		text-decoration: underline;
	}

	.lane-box-title-static {
		pointer-events: none;
		cursor: default;
	}

	.lane-cap {
		position: absolute;
		transform: translate(-50%, -50%);
		height: 20px;
		display: flex;
		align-items: center;
		padding: 0 9px;
		border-radius: 9999px;
		border: 1px solid;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		background: var(--color-base-100);
		white-space: nowrap;
	}

	/* Matches `NODE_META.start.color` / `NODE_META.end.color`, so a lane's caps read as the same
	   kind of thing as the workflow's own start and end nodes. */
	.lane-cap-start {
		color: #22c55e;
		border-color: #22c55e66;
	}

	.lane-cap-end {
		color: #94a3b8;
		border-color: #94a3b866;
	}

	.lane-stub {
		position: absolute;
		width: 0;
		transform: translateX(-50%);
		border-left: 1px solid var(--color-base-300);
	}
</style>
