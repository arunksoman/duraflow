<script lang="ts">
	import type { CaseEntry, CaseRouting } from './builderConfig';
	import type { AvailVar } from './availableVars';
	import ConditionBuilder from './ConditionBuilder.svelte';

	interface Props {
		caseEntry: CaseEntry;
		availVars: AvailVar[];
		/** What a `task` jump may land on: a sibling task, or a named workflow's Start. */
		targetOptions: { value: string; label: string }[];
		onchange: (patch: Partial<CaseEntry>) => void;
	}

	let { caseEntry, availVars, targetOptions, onchange }: Props = $props();

	const ROUTINGS: { value: CaseRouting; label: string; hint: string }[] = [
		{
			value: 'task',
			label: 'Go to…',
			hint: 'Hands the run to a task beside the switch, or to a named workflow, which then takes over.'
		},
		{
			value: 'continue',
			label: 'continue',
			hint: 'Skips the switch and carries on with the task after it.'
		},
		{
			value: 'exit',
			label: 'exit',
			hint: 'Leaves the current scope — a loop body, or the workflow.'
		},
		{ value: 'end', label: 'end', hint: 'Terminates the whole workflow.' }
	];

	const routingHint = $derived(ROUTINGS.find((r) => r.value === caseEntry.routing)?.hint ?? '');
	const isOtherwise = $derived(!caseEntry.condition.trim());

	function setRouting(value: CaseRouting) {
		// A jump needs somewhere to land: default to the first sibling rather than leaving the case
		// pointing nowhere, which would serialize as `continue` and silently not be the jump asked for.
		if (value === 'task' && !caseEntry.targetNodeId) {
			onchange({ routing: value, targetNodeId: targetOptions[0]?.value });
			return;
		}
		onchange({ routing: value });
	}
</script>

<div class="flex flex-col gap-2">
	<label class="flex items-center gap-1.5">
		<span class="text-base-content/40 w-12 shrink-0 text-[10px]">name</span>
		<input
			class="input input-xs min-w-0 flex-1 font-mono"
			placeholder="electronic"
			value={caseEntry.name}
			oninput={(e) => onchange({ name: (e.target as HTMLInputElement).value })}
		/>
	</label>

	<div class="flex flex-col gap-0.5">
		<span class="text-base-content/40 text-[10px]">when</span>
		<ConditionBuilder
			value={caseEntry.condition}
			placeholder={'${ .status == "ok" }  (blank = otherwise)'}
			{availVars}
			onchange={(val) => onchange({ condition: val })}
		/>
		<span class="text-base-content/30 text-[9px]">
			{isOtherwise
				? 'Blank — this case matches anything that reaches it. Put it last.'
				: 'Cases are tried top to bottom; the first match wins.'}
		</span>
	</div>

	<label class="flex items-center gap-1.5">
		<span class="text-base-content/40 w-12 shrink-0 text-[10px]">goes to</span>
		<select
			class="select select-xs min-w-0 flex-1 text-xs"
			value={caseEntry.routing}
			onchange={(e) => setRouting((e.target as HTMLSelectElement).value as CaseRouting)}
		>
			{#each ROUTINGS as r (r.value)}
				<option value={r.value} disabled={r.value === 'task' && targetOptions.length === 0}>
					{r.label}
				</option>
			{/each}
		</select>
	</label>

	{#if caseEntry.routing === 'task'}
		<label class="flex items-center gap-1.5">
			<span class="text-base-content/40 w-12 shrink-0 text-[10px]">target</span>
			<select
				class="select select-xs min-w-0 flex-1 text-xs"
				value={caseEntry.targetNodeId ?? ''}
				onchange={(e) => onchange({ targetNodeId: (e.target as HTMLSelectElement).value })}
			>
				{#each targetOptions as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
		</label>
	{/if}

	<p class="text-base-content/30 text-[9px]">{routingHint}</p>
</div>
