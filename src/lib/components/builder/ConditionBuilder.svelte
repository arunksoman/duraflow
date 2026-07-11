<script lang="ts">
	import type { AvailVar } from './ExpressionInput.svelte';
	import ExpressionInput from './ExpressionInput.svelte';
	import { untrack } from 'svelte';

	interface Props {
		value: string;
		availVars: AvailVar[];
		placeholder?: string;
		onchange: (val: string) => void;
	}

	type Op = '==' | '!=' | '>=' | '<=' | '>' | '<' | '| not';
	type RightType = 'str' | 'num' | 'bool' | 'null' | 'var';

	interface ConditionClause {
		left: string;
		op: Op;
		rightType: RightType;
		rightVal: string;
		join: 'and' | 'or' | null;
	}

	const OPERATORS: Op[] = ['==', '!=', '>=', '<=', '>', '<', '| not'];
	const RIGHT_TYPES: RightType[] = ['str', 'num', 'bool', 'null', 'var'];
	const RIGHT_TYPE_LABELS: Record<RightType, string> = {
		str: '"…"', num: '123', bool: 'T/F', null: 'nil', var: '$var'
	};

	let { value, availVars, placeholder = '${ condition }', onchange }: Props = $props();

	// ── Parsing ──────────────────────────────────────────────────────────

	function parseRightVal(raw: string): { type: RightType; val: string } {
		const t = raw.trim();
		if (t === 'null') return { type: 'null', val: '' };
		if (t === 'true' || t === 'false') return { type: 'bool', val: t };
		if (/^\d+(\.\d+)?$/.test(t)) return { type: 'num', val: t };
		if (/^".*"$/s.test(t)) return { type: 'str', val: t.slice(1, -1) };
		if (/^'.*'$/s.test(t)) return { type: 'str', val: t.slice(1, -1) };
		if (t.startsWith('$') || t.startsWith('.')) return { type: 'var', val: t };
		return { type: 'str', val: t };
	}

	function parseClause(expr: string): Omit<ConditionClause, 'join'> | null {
		const t = expr.trim();
		const notM = t.match(/^(.+?)\s*\|\s*not$/s);
		if (notM) return { left: notM[1].trim(), op: '| not', rightType: 'null', rightVal: '' };
		const m = t.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/s);
		if (!m) return null;
		const { type, val } = parseRightVal(m[3].trim());
		return { left: m[1].trim(), op: m[2] as Op, rightType: type, rightVal: val };
	}

	function splitOnLogical(inner: string): { part: string; join: 'and' | 'or' | null }[] | null {
		const results: { part: string; join: 'and' | 'or' | null }[] = [];
		let current = '';
		let depth = 0;
		let inStr = false;
		let strCh = '';
		let i = 0;
		while (i < inner.length) {
			const ch = inner[i];
			if (inStr) {
				current += ch;
				if (ch === strCh && inner[i - 1] !== '\\') inStr = false;
				i++; continue;
			}
			if (ch === '"' || ch === "'") { inStr = true; strCh = ch; current += ch; i++; continue; }
			if ('([{'.includes(ch)) { depth++; current += ch; i++; continue; }
			if (')]}'.includes(ch)) { depth--; current += ch; i++; continue; }
			if (depth === 0 && inner.slice(i).startsWith(' and ')) {
				results.push({ part: current.trim(), join: 'and' }); current = ''; i += 5; continue;
			}
			if (depth === 0 && inner.slice(i).startsWith(' or ')) {
				results.push({ part: current.trim(), join: 'or' }); current = ''; i += 4; continue;
			}
			current += ch; i++;
		}
		if (current.trim()) results.push({ part: current.trim(), join: null });
		return results.length > 0 ? results : null;
	}

	function parseCondition(val: string): ConditionClause[] | null {
		if (!val || val.trim() === '') return null;
		const m = val.match(/^\$\{\s*([\s\S]+?)\s*\}$/);
		const inner = m ? m[1] : val;
		const parts = splitOnLogical(inner);
		if (!parts) return null;
		const clauses: ConditionClause[] = [];
		for (const p of parts) {
			const c = parseClause(p.part);
			if (!c) return null;
			clauses.push({ ...c, join: p.join });
		}
		return clauses.length > 0 ? clauses : null;
	}

	// ── Serialization ────────────────────────────────────────────────────

	function serializeRight(type: RightType, val: string): string {
		if (type === 'str') return `"${val}"`;
		if (type === 'null') return 'null';
		if (type === 'bool') return val || 'true';
		if (type === 'num') return val || '0';
		return val;
	}

	function serializeClauses(cs: ConditionClause[]): string {
		if (cs.length === 0) return '';
		const exprs = cs.map((c) =>
			c.op === '| not' ? `${c.left} | not` : `${c.left} ${c.op} ${serializeRight(c.rightType, c.rightVal)}`
		);
		let result = exprs[0];
		for (let idx = 1; idx < exprs.length; idx++) result += ` ${cs[idx - 1].join ?? 'and'} ${exprs[idx]}`;
		return `\${ ${result} }`;
	}

	function defaultClause(): ConditionClause {
		return { left: availVars[0]?.rawRef ?? '.', op: '==', rightType: 'str', rightVal: '', join: null };
	}

	// ExpressionInput emits "${ $input.x }" — strip to raw ref for condition use
	function rawFromExpr(v: string): string {
		const m = v.match(/^\$\{\s*([\s\S]+?)\s*\}$/);
		return m ? m[1].trim() : v;
	}

	// ── State ─────────────────────────────────────────────────────────────

	const _initValue = untrack(() => value);
	const _parsed = parseCondition(_initValue);
	let clauses = $state<ConditionClause[]>(_parsed ?? []);
	let rawMode = $state(_parsed === null && !!_initValue && _initValue.trim() !== '');
	let rawText = $state(_initValue);
	let editingRight = $state<number | null>(null);

	// ── Handlers ─────────────────────────────────────────────────────────

	function emit() { onchange(serializeClauses(clauses)); }

	function addClause() {
		if (clauses.length > 0) {
			clauses = clauses.map((c, i) => (i === clauses.length - 1 ? { ...c, join: 'and' } : c));
		}
		clauses = [...clauses, defaultClause()];
		emit();
	}

	function removeClause(i: number) {
		if (editingRight === i) editingRight = null;
		if (clauses.length <= 1) { clauses = []; emit(); return; }
		else {
			const next = clauses.filter((_, j) => j !== i);
			clauses = next.map((c, j) => (j === next.length - 1 ? { ...c, join: null } : c));
		}
		emit();
	}

	function toggleJoin(i: number) {
		clauses = clauses.map((c, j) => j === i ? { ...c, join: c.join === 'and' ? 'or' : 'and' } : c);
		emit();
	}

	function updateClause(i: number, patch: Partial<ConditionClause>) {
		clauses = clauses.map((c, j) => (j === i ? { ...c, ...patch } : c));
		emit();
	}

	function cycleRightType(i: number) {
		const c = clauses[i];
		const next = RIGHT_TYPES[(RIGHT_TYPES.indexOf(c.rightType) + 1) % RIGHT_TYPES.length];
		const nextVal = next === 'bool' ? 'true' : next === 'null' ? '' : next === 'var' ? (availVars[0]?.rawRef ?? '.') : '';
		updateClause(i, { rightType: next, rightVal: nextVal });
		if (next === 'str' || next === 'num') editingRight = i;
		else editingRight = null;
	}

	function toggleRaw() {
		if (!rawMode) { rawText = serializeClauses(clauses); rawMode = true; }
		else {
			const p = parseCondition(rawText);
			if (p !== null) { clauses = p; rawMode = false; }
			onchange(rawText);
		}
	}

	function stopEdit(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
	}
</script>

{#if rawMode}
	<div class="flex items-center gap-1">
		<input
			class="input input-xs min-w-0 flex-1 font-mono"
			type="text"
			{placeholder}
			value={rawText}
			oninput={(e) => { rawText = (e.target as HTMLInputElement).value; onchange(rawText); }}
		/>
		<button
			type="button"
			class="btn btn-ghost btn-xs shrink-0 px-1.5 font-mono text-[9px] opacity-50 hover:opacity-100"
			onclick={toggleRaw}
		>chip</button>
	</div>
{:else}
	<div class="border-base-300 bg-base-100 flex w-full flex-col rounded-lg border transition-colors focus-within:border-primary/40">
		{#each clauses as clause, i (i)}
			<div class="flex min-w-0 items-center gap-1.5 px-2 py-1 {i > 0 ? 'border-base-300/50 border-t' : ''}">

				<!-- Join / spacer -->
				{#if i > 0}
					<button
						type="button"
						class="w-7 shrink-0 rounded px-1 py-0.5 text-center font-mono text-[9px] font-semibold text-primary/70 hover:bg-primary/10 hover:text-primary"
						onclick={() => toggleJoin(i - 1)}
						title="Toggle and / or"
					>{clauses[i - 1].join ?? 'and'}</button>
				{:else}
					<span class="w-7 shrink-0"></span>
				{/if}

				<!-- Left: ExpressionInput (same component as Start / Set node values) -->
				<div class="flex-1 min-w-0">
					<ExpressionInput
						value={clause.left}
						{availVars}
						placeholder="variable or field"
						onchange={(v) => updateClause(i, { left: rawFromExpr(v) })}
					/>
				</div>

				<!-- Operator: compact bare select -->
				<select
					class="shrink-0 cursor-pointer rounded bg-base-200/50 px-1.5 py-0.5 font-mono text-[10px] text-base-content/70 outline-none"
					value={clause.op}
					onchange={(e) => {
						const op = (e.target as HTMLSelectElement).value as Op;
						updateClause(i, {
							op,
							rightType: op === '| not' ? 'null' : clause.rightType,
							rightVal: op === '| not' ? '' : clause.rightVal
						});
						if (op === '| not') editingRight = null;
					}}
				>
					{#each OPERATORS as op (op)}
						<option value={op}>{op}</option>
					{/each}
				</select>

				<!-- Right value -->
				{#if clause.op !== '| not'}
					{#if clause.rightType === 'bool'}
						<button
							type="button"
							class="shrink-0 rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary hover:bg-primary/20"
							onclick={() => updateClause(i, { rightVal: clause.rightVal === 'true' ? 'false' : 'true' })}
						>{clause.rightVal || 'true'}</button>

					{:else if clause.rightType === 'null'}
						<span class="shrink-0 px-1 font-mono text-[10px] text-base-content/40">null</span>

					{:else if clause.rightType === 'str'}
						{#if editingRight === i}
							<span class="inline-flex items-center rounded bg-success/10 px-1 py-0.5 font-mono text-[10px]">
								<span class="select-none text-success/60">"</span>
								<input
									{@attach (node) => { (node as HTMLInputElement).focus(); }}
									class="min-w-12 max-w-40 bg-transparent font-mono text-[10px] text-base-content outline-none"
									value={clause.rightVal}
									oninput={(e) => updateClause(i, { rightVal: (e.target as HTMLInputElement).value })}
									onblur={() => (editingRight = null)}
									onkeydown={stopEdit}
								/>
								<span class="select-none text-success/60">"</span>
							</span>
						{:else}
							<button
								type="button"
								class="inline-flex max-w-36 shrink-0 items-center rounded bg-success/10 px-1 py-0.5 font-mono text-[10px] hover:bg-success/20"
								title={clause.rightVal || 'click to set value'}
								onclick={() => (editingRight = i)}
							>
								<span class="select-none text-success/60">"</span>
								{#if clause.rightVal}
									<span class="max-w-28 truncate text-base-content/80">{clause.rightVal}</span>
								{:else}
									<span class="italic text-base-content/30">value</span>
								{/if}
								<span class="select-none text-success/60">"</span>
							</button>
						{/if}

					{:else if clause.rightType === 'num'}
						{#if editingRight === i}
							<span class="inline-flex items-center rounded bg-warning/10 px-1 py-0.5 font-mono text-[10px]">
								<span class="mr-0.5 select-none text-warning/60">#</span>
								<input
									{@attach (node) => { (node as HTMLInputElement).focus(); }}
									type="number"
									class="w-20 bg-transparent font-mono text-[10px] text-base-content outline-none"
									value={clause.rightVal}
									oninput={(e) => updateClause(i, { rightVal: (e.target as HTMLInputElement).value })}
									onblur={() => (editingRight = null)}
									onkeydown={stopEdit}
								/>
							</span>
						{:else}
							<button
								type="button"
								class="inline-flex shrink-0 items-center rounded bg-warning/10 px-1 py-0.5 font-mono text-[10px] hover:bg-warning/20"
								title={clause.rightVal || 'click to set number'}
								onclick={() => (editingRight = i)}
							>
								<span class="mr-0.5 select-none text-warning/60">#</span>
								<span class="text-base-content/80">{clause.rightVal || '0'}</span>
							</button>
						{/if}

					{:else if clause.rightType === 'var'}
						<!-- Right var: same ExpressionInput as left -->
						<div class="flex-1 min-w-0">
							<ExpressionInput
								value={clause.rightVal}
								{availVars}
								placeholder="variable"
								onchange={(v) => updateClause(i, { rightVal: rawFromExpr(v) })}
							/>
						</div>
					{/if}
				{:else}
					<span class="px-0.5 text-[9px] italic text-base-content/30">is falsy</span>
				{/if}

				<!-- Controls -->
				<div class="ml-auto flex shrink-0 items-center gap-1">
					{#if clause.op !== '| not'}
						<button
							type="button"
							class="font-mono text-[9px] text-base-content/20 hover:text-base-content/60"
							onclick={() => cycleRightType(i)}
							title="Value type: {RIGHT_TYPE_LABELS[clause.rightType]}"
						>{RIGHT_TYPE_LABELS[clause.rightType]}</button>
					{/if}
					{#if clauses.length > 1}
						<button
							type="button"
							class="font-mono text-[11px] leading-none text-base-content/20 hover:text-error"
							onclick={() => removeClause(i)}
							aria-label="Remove condition"
						>×</button>
					{/if}
				</div>
			</div>
		{/each}

		<!-- Footer -->
		<div class="border-base-300/50 flex items-center border-t px-2 py-1">
			<button
				type="button"
				class="font-mono text-[9px] text-base-content/30 hover:text-base-content/70"
				onclick={addClause}
			>+ add condition</button>
			<button
				type="button"
				class="ml-auto font-mono text-[8px] text-base-content/20 hover:text-base-content/60"
				onclick={toggleRaw}
				title="Edit raw jq expression"
			>&lt;/&gt;</button>
		</div>
	</div>
{/if}
