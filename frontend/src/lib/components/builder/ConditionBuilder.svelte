<script lang="ts">
	import { untrack } from 'svelte';
	import type { AvailVar } from './availableVars';
	import ExpressionInput from './ExpressionInput.svelte';
	import {
		COMPARISON_OPS,
		FUNCTION_OPS,
		OP_LABEL,
		UNARY_OPS,
		isUnary,
		parseCondition,
		serializeCondition,
		type ConditionClause,
		type ConditionOp,
		type RightKind
	} from '$lib/zigflow-engine/condition';
	import { parseRef, refToJq } from '$lib/zigflow-engine/expression';

	interface Props {
		value: string;
		availVars: AvailVar[];
		placeholder?: string;
		onchange: (val: string) => void;
	}

	let { value, availVars, placeholder = '${ condition }', onchange }: Props = $props();

	const RIGHT_KINDS: { kind: RightKind; label: string }[] = [
		{ kind: 'string', label: 'text' },
		{ kind: 'number', label: 'number' },
		{ kind: 'bool', label: 'true/false' },
		{ kind: 'null', label: 'null' },
		{ kind: 'expr', label: 'variable' }
	];

	// Rows get a local id so a removed row never hands its editors to the row below it.
	type Row = ConditionClause & { id: number };
	let nextId = 0;
	const toRows = (cs: ConditionClause[]): Row[] => cs.map((c) => ({ ...c, id: nextId++ }));

	// Same controlled-field contract as ExpressionInput: re-parse only values this field didn't emit.
	let lastEmitted = untrack(() => value);
	let rows = $state<Row[]>(untrack(() => toRows(parseCondition(value))));
	let rawMode = $state(false);
	let rawText = $state(untrack(() => value));

	$effect(() => {
		const incoming = value;
		untrack(() => {
			if (incoming === lastEmitted) return;
			lastEmitted = incoming;
			rows = toRows(parseCondition(incoming));
			rawText = incoming;
		});
	});

	function emit() {
		const next = serializeCondition(rows);
		lastEmitted = next;
		onchange(next);
	}

	/** The right operand that fits the left one's declared type — a boolean flag compares to `true`. */
	function defaultRight(left: string): ConditionClause['right'] {
		const ref = parseRef(left);
		const known =
			ref && availVars.find((v) => refToJq(v.source, v.path) === refToJq(ref.source, ref.path));
		if (known?.type === 'number') return { kind: 'number', value: '' };
		if (known?.type === 'boolean') return { kind: 'bool', value: 'true' };
		return { kind: 'string', value: '' };
	}

	function addRow(join: 'and' | 'or') {
		if (rows.length > 0) rows[rows.length - 1].join = join;
		rows.push({
			id: nextId++,
			left: '',
			op: '==',
			right: { kind: 'string', value: '' },
			join: 'and'
		});
		emit();
	}

	function removeRow(i: number) {
		rows.splice(i, 1);
		emit();
	}

	function setLeft(i: number, left: string) {
		const row = rows[i];
		// A fresh row adopts the operand's type the first time a variable is picked.
		if (!row.left.trim() && row.right.kind === 'string' && !row.right.value)
			row.right = defaultRight(left);
		row.left = left;
		emit();
	}

	function setOp(i: number, op: ConditionOp) {
		const row = rows[i];
		const wasUnary = isUnary(row.op);
		row.op = op;
		if (FUNCTION_OPS.includes(op) && row.right.kind !== 'string' && row.right.kind !== 'expr') {
			row.right = { kind: 'string', value: '' };
		} else if (wasUnary && !isUnary(op)) {
			row.right = defaultRight(row.left);
		}
		emit();
	}

	function setRightKind(i: number, kind: RightKind) {
		const row = rows[i];
		row.right = { kind, value: kind === 'bool' ? 'true' : '' };
		emit();
	}

	function setRightValue(i: number, v: string) {
		rows[i].right.value = v;
		emit();
	}

	function toggleRaw() {
		if (!rawMode) {
			rawText = serializeCondition(rows);
			rawMode = true;
		} else {
			rows = toRows(parseCondition(rawText));
			rawMode = false;
		}
	}
</script>

{#if rawMode}
	<div class="flex items-center gap-1">
		<input
			class="input input-xs min-w-0 flex-1 font-mono"
			type="text"
			{placeholder}
			value={rawText}
			oninput={(e) => {
				rawText = (e.target as HTMLInputElement).value;
				lastEmitted = rawText;
				onchange(rawText);
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === 'Escape') {
					e.preventDefault();
					toggleRaw();
				}
			}}
		/>
		<button
			type="button"
			class="text-base-content/40 hover:text-base-content/80 shrink-0 px-1 font-mono text-[9px]"
			onclick={toggleRaw}
			title="Back to the visual builder">visual</button
		>
	</div>
{:else}
	<div class="border-base-300 bg-base-100 flex w-full flex-col rounded-lg border">
		{#each rows as row, i (row.id)}
			<div class={['flex items-start gap-1.5 px-2 py-1.5', i > 0 && 'border-base-300/50 border-t']}>
				{#if i > 0}
					<button
						type="button"
						class="text-primary/80 hover:bg-primary/10 mt-0.5 w-8 shrink-0 rounded px-1 py-0.5 text-center font-mono text-[9px] font-semibold uppercase"
						onclick={() => {
							rows[i - 1].join = rows[i - 1].join === 'and' ? 'or' : 'and';
							emit();
						}}
						title="Toggle AND / OR">{rows[i - 1].join}</button
					>
				{:else}
					<span
						class="text-base-content/35 mt-1 w-8 shrink-0 text-center text-[9px] font-semibold uppercase"
						>if</span
					>
				{/if}

				<div class="flex min-w-0 flex-1 flex-col gap-1">
					<ExpressionInput
						value={row.left}
						mode="jq"
						{availVars}
						placeholder="variable…"
						onchange={(v) => setLeft(i, v)}
					/>
					<div class="flex min-w-0 flex-wrap items-center gap-1">
						<select
							class="bg-base-200/60 text-base-content/80 shrink-0 cursor-pointer rounded px-1 py-0.5 text-[10px] outline-none"
							value={row.op}
							aria-label="Operator"
							onchange={(e) => setOp(i, (e.target as HTMLSelectElement).value as ConditionOp)}
						>
							<optgroup label="Compare">
								{#each COMPARISON_OPS as op (op)}<option value={op}>{OP_LABEL[op]}</option>{/each}
							</optgroup>
							<optgroup label="Text / list">
								{#each FUNCTION_OPS as op (op)}<option value={op}>{OP_LABEL[op]}</option>{/each}
							</optgroup>
							<optgroup label="Check">
								{#each UNARY_OPS as op (op)}<option value={op}>{OP_LABEL[op]}</option>{/each}
							</optgroup>
						</select>

						{#if !isUnary(row.op)}
							{#if row.right.kind === 'string'}
								<span
									class="bg-success/10 focus-within:ring-success/40 inline-flex min-w-0 flex-1 items-center rounded px-1 font-mono text-[10px] focus-within:ring-1"
								>
									<span class="text-success/60 select-none">"</span>
									<input
										class="text-base-content min-w-0 flex-1 bg-transparent py-0.5 outline-none"
										placeholder={row.op === 'test' ? 'regex' : 'value'}
										value={row.right.value}
										oninput={(e) => setRightValue(i, (e.target as HTMLInputElement).value)}
									/>
									<span class="text-success/60 select-none">"</span>
								</span>
							{:else if row.right.kind === 'number'}
								<input
									class="bg-warning/10 focus:ring-warning/40 min-w-0 flex-1 rounded px-1 py-0.5 font-mono text-[10px] outline-none focus:ring-1"
									inputmode="decimal"
									placeholder="0"
									value={row.right.value}
									oninput={(e) => setRightValue(i, (e.target as HTMLInputElement).value)}
								/>
							{:else if row.right.kind === 'bool'}
								<button
									type="button"
									class="bg-primary/10 text-primary hover:bg-primary/20 rounded px-2 py-0.5 font-mono text-[10px] font-semibold"
									onclick={() => setRightValue(i, row.right.value === 'false' ? 'true' : 'false')}
									>{row.right.value === 'false' ? 'false' : 'true'}</button
								>
							{:else if row.right.kind === 'null'}
								<span class="text-base-content/40 px-1 font-mono text-[10px]">null</span>
							{:else}
								<div class="min-w-0 flex-1">
									<ExpressionInput
										value={row.right.value}
										mode="jq"
										{availVars}
										placeholder="variable…"
										onchange={(v) => setRightValue(i, v)}
									/>
								</div>
							{/if}
							<select
								class="text-base-content/40 hover:text-base-content/70 ml-auto shrink-0 cursor-pointer bg-transparent text-[9px] outline-none"
								value={row.right.kind}
								aria-label="Value type"
								onchange={(e) =>
									setRightKind(i, (e.target as HTMLSelectElement).value as RightKind)}
							>
								{#each RIGHT_KINDS as k (k.kind)}<option value={k.kind}>{k.label}</option>{/each}
							</select>
						{/if}
					</div>
				</div>

				<button
					type="button"
					class="text-base-content/25 hover:text-error mt-0.5 shrink-0 px-0.5 text-[12px] leading-none"
					onclick={() => removeRow(i)}
					aria-label="Remove condition">×</button
				>
			</div>
		{/each}

		<div
			class={[
				'flex items-center gap-2 px-2 py-1',
				rows.length > 0 && 'border-base-300/50 border-t'
			]}
		>
			{#if rows.length === 0}
				<button
					type="button"
					class="text-base-content/40 hover:text-base-content/80 font-mono text-[9px]"
					onclick={() => addRow('and')}>+ add condition</button
				>
			{:else}
				<button
					type="button"
					class="text-base-content/40 hover:text-base-content/80 font-mono text-[9px]"
					onclick={() => addRow('and')}>+ and</button
				>
				<button
					type="button"
					class="text-base-content/40 hover:text-base-content/80 font-mono text-[9px]"
					onclick={() => addRow('or')}>+ or</button
				>
			{/if}
			<button
				type="button"
				class="text-base-content/25 hover:text-base-content/70 ml-auto font-mono text-[8px]"
				onclick={toggleRaw}
				title="Edit raw jq">&lt;/&gt;</button
			>
		</div>
	</div>
{/if}
