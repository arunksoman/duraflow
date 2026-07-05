<script lang="ts">
	import type { AvailVar } from './ExpressionInput.svelte';
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
		leftIsCustom: boolean;
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

	const CAT_COLOR: Record<string, string> = {
		input: 'var(--color-primary)',
		env: 'var(--color-warning)',
		data: 'var(--color-success)',
		context: 'var(--color-info)',
		output: 'var(--color-secondary)'
	};
	const CAT_LETTER: Record<string, string> = {
		input: 'I', env: 'E', data: 'D', context: 'C', output: 'O'
	};

	const JQ_TRANSFORMS: { name: string; desc: string }[] = [
		{ name: 'not', desc: 'negate boolean' },
		{ name: 'length', desc: 'count items' },
		{ name: 'type', desc: 'type name' },
		{ name: 'keys', desc: 'object keys' },
		{ name: 'values', desc: 'object values' },
		{ name: 'first', desc: 'first element' },
		{ name: 'last', desc: 'last element' },
		{ name: 'reverse', desc: 'reverse array' },
		{ name: 'unique', desc: 'deduplicate' },
		{ name: 'sort', desc: 'sort array' },
		{ name: 'ascii_downcase', desc: 'lowercase' },
		{ name: 'ascii_upcase', desc: 'uppercase' },
		{ name: 'tostring', desc: 'to string' },
		{ name: 'tonumber', desc: 'to number' },
		{ name: 'floor', desc: 'floor' },
		{ name: 'ceil', desc: 'ceil' },
		{ name: 'round', desc: 'round' },
		{ name: 'abs', desc: 'absolute value' },
		{ name: 'to_entries', desc: 'to entries' },
		{ name: 'from_entries', desc: 'from entries' }
	];

	let { value, availVars, placeholder = '${ condition }', onchange }: Props = $props();

	// ── Helpers ──────────────────────────────────────────────────────────

	function varMeta(rawRef: string): { color: string; letter: string; label: string } {
		if (rawRef.startsWith('.')) return { color: 'var(--color-secondary)', letter: '·', label: rawRef };
		const v = availVars.find((av) => av.rawRef === rawRef);
		if (v) return { color: CAT_COLOR[v.category] ?? 'currentColor', letter: CAT_LETTER[v.category] ?? '?', label: v.field || v.source };
		if (rawRef.startsWith('$')) {
			const base = rawRef.split('.')[0];
			const bv = availVars.find((av) => av.rawRef === base || av.source === base);
			const field = rawRef.slice(base.length).replace(/^\./, '') || rawRef.slice(1);
			if (bv) return { color: CAT_COLOR[bv.category] ?? 'currentColor', letter: CAT_LETTER[bv.category] ?? '?', label: field };
			return { color: 'currentColor', letter: '$', label: field };
		}
		return { color: 'currentColor', letter: '?', label: rawRef };
	}

	function isKnownRef(raw: string): boolean {
		return raw.startsWith('.') || raw.startsWith('$') || availVars.some((v) => v.rawRef === raw);
	}

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
		if (notM) {
			const left = notM[1].trim();
			return { left, leftIsCustom: !isKnownRef(left), op: '| not', rightType: 'null', rightVal: '' };
		}
		const m = t.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/s);
		if (!m) return null;
		const left = m[1].trim();
		const op = m[2] as Op;
		const { type, val } = parseRightVal(m[3].trim());
		return { left, leftIsCustom: !isKnownRef(left), op, rightType: type, rightVal: val };
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
		return { left: availVars[0]?.rawRef ?? '.', leftIsCustom: false, op: '==', rightType: 'str', rightVal: '', join: null };
	}

	// ── Autocomplete ─────────────────────────────────────────────────────

	function computeVarAc(q: string): { value: string; label: string; hint: string }[] {
		const pipeIdx = q.lastIndexOf('|');
		if (pipeIdx >= 0) {
			const base = q.slice(0, pipeIdx).trimEnd();
			const after = q.slice(pipeIdx + 1).trim().toLowerCase();
			return JQ_TRANSFORMS
				.filter((t) => after === '' || t.name.toLowerCase().startsWith(after))
				.map((t) => ({ value: `${base} | ${t.name}`, label: `| ${t.name}`, hint: t.desc }))
				.slice(0, 8);
		}
		const lower = q.toLowerCase();
		const items: { value: string; label: string; hint: string }[] = [];
		if (lower === '' || '.'.startsWith(lower) || lower.startsWith('.')) {
			items.push({ value: '.', label: '.', hint: 'input' });
		}
		for (const v of availVars) {
			if (v.rawRef.toLowerCase().includes(lower) || (v.field || '').toLowerCase().includes(lower)) {
				items.push({ value: v.rawRef, label: v.rawRef, hint: v.category });
			}
		}
		return items.slice(0, 8);
	}

	// ── State ─────────────────────────────────────────────────────────────

	const _initValue = untrack(() => value);
	const _parsed = parseCondition(_initValue);
	let clauses = $state<ConditionClause[]>(_parsed ?? [defaultClause()]);
	let rawMode = $state(_parsed === null && !!_initValue && _initValue.trim() !== '');
	let rawText = $state(_initValue);
	let editingRight = $state<number | null>(null);

	// Left typeahead
	let editingLeft = $state<number | null>(null);
	let leftQuery = $state('');
	let leftAcFocus = $state(0);
	let leftAcItems = $derived(editingLeft !== null ? computeVarAc(leftQuery) : []);

	// Right-var typeahead
	let editingRightVar = $state<number | null>(null);
	let rightVarQuery = $state('');
	let rightVarAcFocus = $state(0);
	let rightVarAcItems = $derived(editingRightVar !== null ? computeVarAc(rightVarQuery) : []);

	// ── Handlers ─────────────────────────────────────────────────────────

	function emit() { onchange(serializeClauses(clauses)); }

	function addClause() {
		clauses = clauses.map((c, i) => (i === clauses.length - 1 ? { ...c, join: 'and' } : c));
		clauses = [...clauses, defaultClause()];
		editingRight = clauses.length - 1;
		emit();
	}

	function removeClause(i: number) {
		if (editingRight === i) editingRight = null;
		if (editingLeft === i) { editingLeft = null; leftQuery = ''; }
		if (editingRightVar === i) { editingRightVar = null; rightVarQuery = ''; }
		if (clauses.length <= 1) { clauses = [defaultClause()]; }
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
		if (next === 'str' || next === 'num') { editingRight = i; editingRightVar = null; rightVarQuery = ''; }
		else if (next === 'var') { editingRightVar = i; rightVarQuery = nextVal; rightVarAcFocus = 0; editingRight = null; }
		else { editingRight = null; editingRightVar = null; rightVarQuery = ''; }
	}

	// Left typeahead handlers
	function startEditLeft(i: number) {
		editingLeft = i; leftQuery = clauses[i].left; leftAcFocus = 0;
	}
	function selectLeft(i: number, val: string) {
		updateClause(i, { left: val, leftIsCustom: !isKnownRef(val) });
		editingLeft = null; leftQuery = '';
	}
	function handleLeftBlur(i: number) {
		const q = leftQuery.trim();
		if (q) updateClause(i, { left: q, leftIsCustom: !isKnownRef(q) });
		editingLeft = null; leftQuery = '';
	}
	function handleLeftKeydown(e: KeyboardEvent, i: number) {
		if (e.key === 'Escape') { editingLeft = null; leftQuery = ''; return; }
		if (e.key === 'ArrowDown') { leftAcFocus = Math.min(leftAcFocus + 1, leftAcItems.length - 1); e.preventDefault(); return; }
		if (e.key === 'ArrowUp') { leftAcFocus = Math.max(leftAcFocus - 1, 0); e.preventDefault(); return; }
		if ((e.key === 'Enter' || e.key === 'Tab') && leftAcItems.length > 0) {
			selectLeft(i, leftAcItems[leftAcFocus].value); e.preventDefault();
		}
	}

	// Right-var typeahead handlers
	function startEditRightVar(i: number) {
		editingRightVar = i; rightVarQuery = clauses[i].rightVal; rightVarAcFocus = 0;
	}
	function selectRightVar(i: number, val: string) {
		updateClause(i, { rightVal: val });
		editingRightVar = null; rightVarQuery = '';
	}
	function handleRightVarBlur(i: number) {
		const q = rightVarQuery.trim();
		if (q) updateClause(i, { rightVal: q });
		editingRightVar = null; rightVarQuery = '';
	}
	function handleRightVarKeydown(e: KeyboardEvent, i: number) {
		if (e.key === 'Escape') { editingRightVar = null; rightVarQuery = ''; return; }
		if (e.key === 'ArrowDown') { rightVarAcFocus = Math.min(rightVarAcFocus + 1, rightVarAcItems.length - 1); e.preventDefault(); return; }
		if (e.key === 'ArrowUp') { rightVarAcFocus = Math.max(rightVarAcFocus - 1, 0); e.preventDefault(); return; }
		if ((e.key === 'Enter' || e.key === 'Tab') && rightVarAcItems.length > 0) {
			selectRightVar(i, rightVarAcItems[rightVarAcFocus].value); e.preventDefault();
		}
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
	<!-- overflow-visible so autocomplete dropdowns can escape the container -->
	<div class="border-base-300 bg-base-100 flex w-full flex-col rounded-lg border transition-colors focus-within:border-primary/40">
		{#each clauses as clause, i (i)}
			<div class="flex min-w-0 items-center gap-1.5 px-2 py-1.5 {i > 0 ? 'border-base-300/50 border-t' : ''}">

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

				<!-- Left: typeahead input or chip -->
				{#if editingLeft === i}
					<div class="relative shrink-0">
						<input
							{@attach (node) => { (node as HTMLInputElement).focus(); }}
							class="w-36 rounded border border-primary/40 bg-base-200 px-1.5 py-0.5 font-mono text-[10px] text-base-content outline-none"
							value={leftQuery}
							oninput={(e) => { leftQuery = (e.target as HTMLInputElement).value; leftAcFocus = 0; }}
							onblur={() => handleLeftBlur(i)}
							onkeydown={(e) => handleLeftKeydown(e, i)}
							placeholder="variable or .field"
						/>
						{#if leftAcItems.length > 0}
							<div
								role="listbox"
								tabindex="-1"
								class="absolute left-0 top-full z-50 mt-0.5 min-w-44 overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-lg"
								onmousedown={(e) => e.preventDefault()}
							>
								{#each leftAcItems as item, j (item.value)}
									<button
										type="button"
										role="option"
										aria-selected={j === leftAcFocus}
										class="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[10px] {j === leftAcFocus ? 'bg-primary/10 text-primary' : 'hover:bg-base-200/60'}"
										onclick={() => selectLeft(i, item.value)}
									>
										<span class="min-w-0 flex-1 truncate">{item.label}</span>
										<span class="shrink-0 text-[9px] text-base-content/40">{item.hint}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{:else if !isKnownRef(clause.left) && clause.left}
					<button
						type="button"
						class="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded border border-base-300 bg-base-200/60 px-1 py-0.5 transition-colors hover:bg-base-200"
						title={clause.left}
						onclick={() => startEditLeft(i)}
					>
						<span class="font-mono text-[8px] text-base-content/30">jq</span>
						<span class="max-w-20 truncate font-mono text-[10px] text-base-content/70">{clause.left}</span>
					</button>
				{:else}
					{@const lm = varMeta(clause.left)}
					<button
						type="button"
						class="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded bg-base-200 px-1 py-0.5 transition-colors hover:bg-base-300"
						title={clause.left || 'click to set variable'}
						onclick={() => startEditLeft(i)}
					>
						<span class="flex size-4 shrink-0 items-center justify-center rounded font-mono text-[8px] font-bold text-white" style:background={lm.color}>{lm.letter}</span>
						<span class="max-w-28 truncate font-mono text-[10px] text-base-content/80">{lm.label}</span>
					</button>
				{/if}

				<!-- Operator: compact bare select -->
				<select
					class="shrink-0 cursor-pointer rounded bg-base-200/50 px-1.5 py-0.5 font-mono text-[10px] text-base-content/70 outline-none"
					value={clause.op}
					onchange={(e) => {
						const op = (e.target as HTMLSelectElement).value as Op;
						updateClause(i, { op, rightType: op === '| not' ? 'null' : clause.rightType, rightVal: op === '| not' ? '' : clause.rightVal });
						if (op === '| not') { editingRight = null; editingRightVar = null; rightVarQuery = ''; }
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
									class="min-w-12 max-w-48 bg-transparent font-mono text-[10px] text-base-content outline-none"
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
								class="inline-flex max-w-44 shrink-0 items-center rounded bg-success/10 px-1 py-0.5 font-mono text-[10px] hover:bg-success/20"
								title={clause.rightVal || 'click to set value'}
								onclick={() => (editingRight = i)}
							>
								<span class="select-none text-success/60">"</span>
								{#if clause.rightVal}
									<span class="max-w-36 truncate text-base-content/80">{clause.rightVal}</span>
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
						{#if editingRightVar === i}
							<div class="relative shrink-0">
								<input
									{@attach (node) => { (node as HTMLInputElement).focus(); }}
									class="w-36 rounded border border-info/40 bg-base-200 px-1.5 py-0.5 font-mono text-[10px] text-base-content outline-none"
									value={rightVarQuery}
									oninput={(e) => { rightVarQuery = (e.target as HTMLInputElement).value; rightVarAcFocus = 0; }}
									onblur={() => handleRightVarBlur(i)}
									onkeydown={(e) => handleRightVarKeydown(e, i)}
									placeholder="variable or expression"
								/>
								{#if rightVarAcItems.length > 0}
									<div
										role="listbox"
										tabindex="-1"
										class="absolute left-0 top-full z-50 mt-0.5 min-w-44 overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-lg"
										onmousedown={(e) => e.preventDefault()}
									>
										{#each rightVarAcItems as item, j (item.value)}
											<button
												type="button"
												role="option"
												aria-selected={j === rightVarAcFocus}
												class="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[10px] {j === rightVarAcFocus ? 'bg-primary/10 text-primary' : 'hover:bg-base-200/60'}"
												onclick={() => selectRightVar(i, item.value)}
											>
												<span class="min-w-0 flex-1 truncate">{item.label}</span>
												<span class="shrink-0 text-[9px] text-base-content/40">{item.hint}</span>
											</button>
										{/each}
									</div>
								{/if}
							</div>
						{:else}
							{@const rm = varMeta(clause.rightVal)}
							<button
								type="button"
								class="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded bg-base-200 px-1 py-0.5 transition-colors hover:bg-base-300"
								title={clause.rightVal || 'click to set variable'}
								onclick={() => startEditRightVar(i)}
							>
								<span class="flex size-4 shrink-0 items-center justify-center rounded font-mono text-[8px] font-bold text-white" style:background={rm.color}>{rm.letter}</span>
								<span class="max-w-28 truncate font-mono text-[10px] text-base-content/80">{rm.label}</span>
							</button>
						{/if}
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
