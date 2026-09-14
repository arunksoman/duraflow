<script lang="ts">
	import { untrack } from 'svelte';
	import { Plus, Trash2 } from '@lucide/svelte';
	import type { AvailVar } from './availableVars';
	import ExpressionInput from './ExpressionInput.svelte';
	import {
		parseExportAs,
		parseOutputAs,
		serializeExportMerge,
		serializeOutputFields,
		type ExportMode,
		type KeyValue,
		type OutputMode
	} from '$lib/zigflow-engine/dataFlow';

	interface Props {
		outputAs: string;
		exportAs: string;
		/** This task's DSL name — the suggested context key when exporting its whole result. */
		taskName: string;
		availVars: AvailVar[];
		onchange: (patch: { outputAs?: string; exportAs?: string }) => void;
	}

	let { outputAs, exportAs, taskName, availVars, onchange }: Props = $props();

	// The panel is recreated per node (`{#key}` in the builder page), so parsing once is enough.
	const initialOutput = untrack(() => parseOutputAs(outputAs));
	const initialExport = untrack(() => parseExportAs(exportAs));

	let outputMode = $state<OutputMode>(initialOutput.mode);
	let outputFields = $state<KeyValue[]>(initialOutput.fields);
	let exportMode = $state<ExportMode>(initialExport.mode);
	let exportFields = $state<KeyValue[]>(initialExport.fields);

	// Values each mode last produced, so flipping modes back and forth doesn't lose work.
	let outputCustom = $state(untrack(() => (initialOutput.mode === 'custom' ? outputAs : '')));
	let exportCustom = $state(untrack(() => (initialExport.mode === 'custom' ? exportAs : '')));

	const OUTPUT_MODES: { mode: OutputMode; label: string }[] = [
		{ mode: 'default', label: 'As is' },
		{ mode: 'fields', label: 'Pick fields' },
		{ mode: 'custom', label: 'Expression' }
	];
	const EXPORT_MODES: { mode: ExportMode; label: string }[] = [
		{ mode: 'none', label: 'Nothing' },
		{ mode: 'merge', label: 'Add keys' },
		{ mode: 'custom', label: 'Expression' }
	];

	function emitOutput() {
		const value =
			outputMode === 'default'
				? ''
				: outputMode === 'fields'
					? serializeOutputFields(outputFields)
					: outputCustom;
		onchange({ outputAs: value });
	}

	function emitExport() {
		const value =
			exportMode === 'none'
				? ''
				: exportMode === 'merge'
					? serializeExportMerge(exportFields)
					: exportCustom;
		onchange({ exportAs: value });
	}

	function setOutputMode(mode: OutputMode) {
		outputMode = mode;
		if (mode === 'fields' && outputFields.length === 0) outputFields = [{ key: '', value: '' }];
		emitOutput();
	}

	function setExportMode(mode: ExportMode) {
		exportMode = mode;
		if (mode === 'merge' && exportFields.length === 0)
			exportFields = [{ key: taskName, value: '.' }];
		emitExport();
	}
</script>

{#snippet segmented(
	options: { mode: string; label: string }[],
	current: string,
	select: (m: string) => void,
	name: string
)}
	<div class="bg-base-200/60 flex rounded-md p-0.5" role="radiogroup" aria-label={name}>
		{#each options as o (o.mode)}
			<button
				type="button"
				role="radio"
				aria-checked={current === o.mode}
				class={[
					'flex-1 rounded px-2 py-0.5 text-[10px] transition',
					current === o.mode
						? 'bg-base-100 text-base-content font-semibold shadow-sm'
						: 'text-base-content/50 hover:text-base-content/80'
				]}
				onclick={() => select(o.mode)}>{o.label}</button
			>
		{/each}
	</div>
{/snippet}

<div class="flex flex-col gap-3">
	<!-- ── output.as ── -->
	<div class="flex flex-col gap-1.5">
		<div class="flex items-baseline justify-between">
			<span class="text-base-content/60 text-[10px] font-semibold tracking-wider uppercase"
				>Output</span
			>
			<span class="text-base-content/30 font-mono text-[9px]">output.as</span>
		</div>
		{@render segmented(
			OUTPUT_MODES,
			outputMode,
			(m) => setOutputMode(m as OutputMode),
			'Output shape'
		)}

		{#if outputMode === 'default'}
			<p class="text-base-content/35 text-[9px]">
				The next task receives this task's result unchanged (as <code>.</code> /
				<code>$output</code>).
			</p>
		{:else if outputMode === 'fields'}
			{#each outputFields as field, i (i)}
				<div class="flex items-start gap-1.5">
					<input
						class="input input-xs w-24 shrink-0 font-mono"
						placeholder="key"
						value={field.key}
						oninput={(e) => {
							field.key = (e.target as HTMLInputElement).value;
							emitOutput();
						}}
					/>
					<div class="min-w-0 flex-1">
						<ExpressionInput
							value={field.value}
							placeholder=". or a field"
							{availVars}
							onchange={(v) => {
								field.value = v;
								emitOutput();
							}}
						/>
					</div>
					<button
						class="btn btn-ghost btn-xs btn-circle text-error mt-0.5 shrink-0"
						onclick={() => {
							outputFields.splice(i, 1);
							emitOutput();
						}}
						aria-label="Remove field"><Trash2 size={9} /></button
					>
				</div>
			{/each}
			<button
				class="btn btn-ghost btn-xs gap-1 self-start"
				onclick={() => outputFields.push({ key: '', value: '' })}><Plus size={9} />Add field</button
			>
			<p class="text-base-content/35 text-[9px]">
				The next task receives an object with just these keys. <code>.</code> is this task's raw result.
			</p>
		{:else}
			<ExpressionInput
				value={outputCustom}
				placeholder={'${ { key: .field } }'}
				{availVars}
				onchange={(v) => {
					outputCustom = v;
					emitOutput();
				}}
			/>
		{/if}
	</div>

	<!-- ── export.as ── -->
	<div class="flex flex-col gap-1.5">
		<div class="flex items-baseline justify-between">
			<span class="text-base-content/60 text-[10px] font-semibold tracking-wider uppercase"
				>Save to context</span
			>
			<span class="text-base-content/30 font-mono text-[9px]">export.as</span>
		</div>
		{@render segmented(
			EXPORT_MODES,
			exportMode,
			(m) => setExportMode(m as ExportMode),
			'Context export'
		)}

		{#if exportMode === 'none'}
			<p class="text-base-content/35 text-[9px]">
				<code>$context</code> is left as earlier tasks set it.
			</p>
		{:else if exportMode === 'merge'}
			{#each exportFields as field, i (i)}
				<div class="flex items-start gap-1.5">
					<div class="flex w-24 shrink-0 items-center">
						<span class="text-info/70 mr-0.5 font-mono text-[9px]">C.</span>
						<input
							class="input input-xs min-w-0 flex-1 font-mono"
							placeholder="key"
							value={field.key}
							oninput={(e) => {
								field.key = (e.target as HTMLInputElement).value;
								emitExport();
							}}
						/>
					</div>
					<div class="min-w-0 flex-1">
						<ExpressionInput
							value={field.value}
							mode="jq"
							placeholder=". or a field"
							{availVars}
							onchange={(v) => {
								field.value = v;
								emitExport();
							}}
						/>
					</div>
					<button
						class="btn btn-ghost btn-xs btn-circle text-error mt-0.5 shrink-0"
						onclick={() => {
							exportFields.splice(i, 1);
							emitExport();
						}}
						aria-label="Remove key"><Trash2 size={9} /></button
					>
				</div>
			{/each}
			<button
				class="btn btn-ghost btn-xs gap-1 self-start"
				onclick={() => exportFields.push({ key: '', value: '' })}><Plus size={9} />Add key</button
			>
			<p class="text-base-content/35 text-[9px]">
				Added to <code>$context</code> — later tasks read them as <code>$context.&lt;key&gt;</code>.
				Existing keys are kept.
			</p>
		{:else}
			<ExpressionInput
				value={exportCustom}
				placeholder={'${ $context + { key: . } }'}
				{availVars}
				onchange={(v) => {
					exportCustom = v;
					emitExport();
				}}
			/>
			<p class="text-base-content/35 text-[9px]">Replaces <code>$context</code> with the result.</p>
		{/if}
	</div>
</div>
