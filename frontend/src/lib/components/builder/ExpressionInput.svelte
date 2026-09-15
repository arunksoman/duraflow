<script lang="ts" module>
	export interface AvailVar {
		expr: string;
		hint: string;
		category: 'input' | 'env' | 'data' | 'context' | 'output';
		source: string;
		field: string;
		rawRef: string;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';

	interface Props {
		value: string;
		placeholder?: string;
		multiline?: boolean;
		rows?: number;
		availVars: AvailVar[];
		onchange: (val: string) => void;
	}

	let {
		value,
		placeholder = '',
		multiline = false,
		rows = 3,
		availVars,
		onchange
	}: Props = $props();

	type LiteralPart = { kind: 'literal'; text: string };
	type VarPart = { kind: 'var'; source: string; field: string; transform: string };
	type ExprPart = LiteralPart | VarPart;

	interface AcItem {
		label: string;
		insert: string;
		hint: string;
		category: string;
		source?: string;
		varData?: AvailVar;
	}

	const TRANSFORMS = [
		'tostring',
		'tonumber',
		'ascii_downcase',
		'ascii_upcase',
		'length',
		'@base64',
		'@uri',
		'keys',
		'values',
		'not',
		'floor',
		'ceil',
		'round',
		'abs',
		'reverse',
		'unique',
		'sort',
		'first',
		'last',
		'flatten',
		'type'
	];

	const SRC_LETTER: Record<string, string> = {
		$input: 'I',
		$env: 'E',
		$data: 'D',
		$context: 'C',
		$output: 'O',
		'.': '·'
	};
	const CAT_COLOR: Record<string, string> = {
		input: 'var(--color-primary)',
		env: 'var(--color-warning)',
		data: 'var(--color-success)',
		context: 'var(--color-info)',
		output: 'var(--color-secondary)'
	};
	const SRC_CAT: Record<string, string> = {
		$input: 'input',
		$env: 'env',
		$data: 'data',
		$context: 'context',
		$output: 'output',
		'.': 'output'
	};

	// ── Parser ─────────────────────────────────────────────────────────────
	function splitOnPlus(inner: string): string[] | null {
		const parts: string[] = [];
		let current = '';
		let depth = 0;
		let inStr = false;
		let strCh = '';
		for (let i = 0; i < inner.length; i++) {
			const ch = inner[i];
			if (inStr) {
				current += ch;
				if (ch === strCh && inner[i - 1] !== '\\') inStr = false;
				continue;
			}
			if (ch === '"' || ch === "'") {
				inStr = true;
				strCh = ch;
				current += ch;
				continue;
			}
			if ('([{'.includes(ch)) {
				depth++;
				current += ch;
				continue;
			}
			if (')]}'.includes(ch)) {
				depth--;
				current += ch;
				continue;
			}
			if (ch === '+' && depth === 0) {
				parts.push(current.trim());
				current = '';
				continue;
			}
			current += ch;
		}
		if (current.trim()) parts.push(current.trim());
		return parts.length > 0 ? parts : null;
	}

	/** True when `t` is one parenthesised group, e.g. `(now | strftime("%Y"))` but not `(a) + (b)`. */
	function isWrappedGroup(t: string): boolean {
		if (!t.startsWith('(') || !t.endsWith(')')) return false;
		let depth = 0;
		let inStr = false;
		for (let i = 0; i < t.length; i++) {
			const ch = t[i];
			if (inStr) {
				if (ch === '\\') i++;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === '(') depth++;
			else if (ch === ')') {
				depth--;
				if (depth === 0 && i < t.length - 1) return false;
			}
		}
		return depth === 0;
	}

	function parseSingleToken(t: string): ExprPart | null {
		const parenVar = t.match(/^\(\$(\w+)(?:\.(\w+))?\s*(\|[^)]+)\)$/);
		if (parenVar)
			return {
				kind: 'var',
				source: '$' + parenVar[1],
				field: parenVar[2] ?? '',
				transform: parenVar[3].trim()
			};
		const dotVar = t.match(/^\$(\w+)\.(\w+)$/);
		if (dotVar) return { kind: 'var', source: '$' + dotVar[1], field: dotVar[2], transform: '' };
		if (t === '.') return { kind: 'var', source: '.', field: '', transform: '' };
		const simpleVar = t.match(/^\$(\w+)(\s*\|.+)?$/);
		if (simpleVar)
			return {
				kind: 'var',
				source: '$' + simpleVar[1],
				field: '',
				transform: simpleVar[2]?.trim() ?? ''
			};
		if (/^"(.*)"$/s.test(t)) {
			// jq string escapes are JSON's, bar `\(…)` interpolation — which JSON.parse rejects,
			// so such strings fall back to a whole-expression chip rather than being mangled.
			try {
				const text = JSON.parse(t);
				return typeof text === 'string' ? { kind: 'literal', text } : null;
			} catch {
				return null;
			}
		}
		// Any other parenthesised sub-expression stays a (raw) expression chip in its slot.
		if (isWrappedGroup(t)) return { kind: 'literal', text: '${ ' + t.slice(1, -1).trim() + ' }' };
		return null;
	}

	function parseValue(val: string): ExprPart[] {
		if (!val || val.trim() === '') return [];
		const exprMatch = val.match(/^\$\{\s*([\s\S]+?)\s*\}$/);
		if (!exprMatch) {
			// Try plain variable refs without ${ } (e.g. from DSL import)
			const tok = parseSingleToken(val.trim());
			if (tok && tok.kind === 'var') return [tok];
			return [{ kind: 'literal', text: val }];
		}
		const inner = exprMatch[1];
		const rawParts = splitOnPlus(inner);
		// Complex/unparseable expression → store as a single expression-literal chip
		if (!rawParts) return [{ kind: 'literal', text: val }];
		const result: ExprPart[] = [];
		for (const raw of rawParts) {
			const tok = parseSingleToken(raw.trim());
			if (!tok) return [{ kind: 'literal', text: val }];
			result.push(tok);
		}
		return result;
	}

	function serializeParts(ps: ExprPart[]): string {
		if (ps.length === 0) return '';
		const allLiteral = ps.every((p) => p.kind === 'literal');
		if (ps.length === 1 && allLiteral) return (ps[0] as LiteralPart).text;
		const inner = ps.map((p) => {
			if (p.kind === 'literal') {
				const text = (p as LiteralPart).text;
				// An expression chip joins the concatenation as a sub-expression, not as a string.
				if (isExprLiteral(text)) return '(' + exprInner(text) + ')';
				return JSON.stringify(text);
			}
			const vp = p as VarPart;
			const ref = vp.source + (vp.field ? '.' + vp.field : '');
			return vp.transform ? '(' + ref + ' ' + vp.transform + ')' : ref;
		});
		return '${ ' + inner.join(' + ') + ' }';
	}

	// ── State ──────────────────────────────────────────────────────────────
	const _init = untrack(() => parseValue(value));
	let parts = $state<ExprPart[]>(_init);
	let rawMode = $state(false);
	let rawText = $state(untrack(() => value));
	let currentText = $state('');
	let chipInputEl = $state<HTMLInputElement | null>(null);
	let rawInputEl = $state<HTMLInputElement | null>(null);
	let acItems = $state<AcItem[]>([]);
	let acIdx = $state(0);
	let acForTransform = $state(false);
	let focused = $state(false);

	// In-place chip editing: the chip being edited is lifted out of `parts` and the text input takes
	// its slot (via CSS `order`, so the input element never remounts and keeps focus). The lifted
	// chip is put back untouched when the edit is cancelled or its text is left unchanged — editing
	// never moves a chip or silently turns a variable into a string.
	let editIdx = $state<number | null>(null);
	let editOriginal = $state.raw<ExprPart | null>(null);
	let editSeed = '';

	// The value this component last emitted or adopted. A `value` prop that differs is an external
	// change (e.g. an index-keyed row above this one was deleted) and has to be re-parsed, since
	// `parts` is otherwise only seeded once.
	let lastValue = untrack(() => value);

	const showAc = $derived(acItems.length > 0);
	const insertIdx = $derived(editIdx ?? parts.length);

	$effect.pre(() => {
		const v = value;
		untrack(() => {
			if (v === lastValue) return;
			lastValue = v;
			// Same expression in another spelling (ConditionBuilder strips `${ }`) — keep local state.
			if (serializeParts(parseValue(v)) === serializeParts(withPending())) return;
			clearPending();
			parts = parseValue(v);
			rawText = v;
		});
	});

	// ── Helpers ────────────────────────────────────────────────────────────
	function srcColor(source: string): string {
		return CAT_COLOR[SRC_CAT[source] ?? 'output'] ?? 'currentColor';
	}

	function trunc(s: string, max = 16): string {
		return s.length > max ? s.slice(0, max - 1) + '…' : s;
	}

	function isExprLiteral(text: string): boolean {
		return /^\$\{[\s\S]*\}$/.test(text.trim());
	}

	function exprInner(text: string): string {
		return text
			.trim()
			.replace(/^\$\{\s*/, '')
			.replace(/\s*\}$/, '');
	}

	/** `parts` with the chip currently being edited put back in its slot. */
	function withPending(): ExprPart[] {
		if (editIdx === null || !editOriginal) return parts;
		return [...parts.slice(0, editIdx), editOriginal, ...parts.slice(editIdx)];
	}

	function emit() {
		const s = serializeParts(withPending());
		if (s === lastValue) return;
		lastValue = s;
		onchange(s);
	}

	function clearPending() {
		editIdx = null;
		editOriginal = null;
		editSeed = '';
		currentText = '';
		if (chipInputEl) chipInputEl.value = '';
	}

	/**
	 * Settles the text input into `parts` at its slot: typed text becomes a literal chip, while a
	 * cancelled or untouched edit restores the chip that was being edited (an edit cleared to empty
	 * removes it). Returns the index a chip landed at, or -1 when none was inserted.
	 */
	function settlePending(mode: 'commit' | 'cancel'): number {
		const at = insertIdx;
		const original = editOriginal;
		const text = currentText;
		let part: ExprPart | null = null;
		if (original && (mode === 'cancel' || text === editSeed)) part = original;
		else if (mode === 'commit' && text.trim() && text.trim() !== '|')
			part = { kind: 'literal', text };
		clearPending();
		if (part) parts = [...parts.slice(0, at), part, ...parts.slice(at)];
		emit();
		return part ? at : -1;
	}

	/** Settles any pending edit, mapping a `parts` index taken before settling to the same chip after. */
	function settleAndShift(i: number): number {
		const landed = settlePending('commit');
		return landed !== -1 && i >= landed ? i + 1 : i;
	}

	// ── Chip mutations ─────────────────────────────────────────────────────
	function removePart(i: number) {
		i = settleAndShift(i);
		parts = parts.filter((_, j) => j !== i);
		emit();
		chipInputEl?.focus();
	}

	/** Backspace in the empty input removes the chip just before it. */
	function removePartBeforeInput() {
		const at = insertIdx;
		if (at === 0) return;
		parts = parts.filter((_, j) => j !== at - 1);
		if (editIdx !== null) editIdx = at - 1;
		emit();
	}

	function editChip(i: number) {
		i = settleAndShift(i);
		const part = parts[i];
		if (!part) return;
		if (part.kind === 'literal' && isExprLiteral(part.text)) {
			// Expression chips are edited in raw mode, over the whole value, so the chips around it
			// are neither dropped nor reordered.
			openRaw();
			return;
		}
		parts = parts.filter((_, j) => j !== i);
		editIdx = i;
		editOriginal = part;
		editSeed = part.kind === 'var' ? part.field || part.source.replace(/^\$/, '') : part.text;
		currentText = editSeed;
		if (chipInputEl) {
			chipInputEl.value = editSeed;
			chipInputEl.focus();
			chipInputEl.select();
		}
		computeChipAc(editSeed);
	}

	// ── Autocomplete ───────────────────────────────────────────────────────
	function computeChipAc(text: string) {
		if (text === '|') {
			const hasVar =
				editOriginal?.kind === 'var' || parts.slice(0, insertIdx).some((p) => p.kind === 'var');
			if (hasVar) {
				acForTransform = true;
				acItems = TRANSFORMS.map((t) => ({
					label: t,
					insert: t,
					hint: '',
					category: 'transform'
				})).slice(0, 12);
				acIdx = 0;
				return;
			}
		}

		acForTransform = false;

		if (!text.trim()) {
			acItems = availVars.slice(0, 10).map((v) => ({
				label: v.field || v.source,
				insert: v.rawRef,
				hint: v.hint || v.source,
				category: v.category,
				source: v.source,
				varData: v
			}));
			acIdx = 0;
			return;
		}

		const q = text.toLowerCase();
		acItems = availVars
			.filter(
				(v) =>
					v.field.toLowerCase().includes(q) ||
					v.source.slice(1).toLowerCase().includes(q) ||
					v.hint.toLowerCase().includes(q)
			)
			.map((v) => ({
				label: v.field || v.source,
				insert: v.rawRef,
				hint: v.source,
				category: v.category,
				source: v.source,
				varData: v
			}))
			.slice(0, 8);
		acIdx = 0;
	}

	function applyAcItem(item: AcItem) {
		if (item.category === 'transform') {
			const transform = '| ' + item.insert;
			if (editOriginal?.kind === 'var') {
				// `|` typed while editing a variable chip sets that chip's own transform.
				editOriginal = { ...editOriginal, transform };
			} else {
				// Otherwise it applies to the nearest variable before the input.
				let lastVarIdx = -1;
				for (let i = insertIdx - 1; i >= 0; i--) {
					if (parts[i].kind === 'var') {
						lastVarIdx = i;
						break;
					}
				}
				if (lastVarIdx >= 0) {
					parts = parts.map((p, i) => (i === lastVarIdx ? { ...p, transform } : p)) as ExprPart[];
				}
			}
			// Drops the typed `|`; restores (the possibly re-transformed) chip being edited.
			settlePending('cancel');
		} else if (item.varData) {
			// The typed text was only a search term — replace it (and any chip being edited) with the
			// variable, in the same slot, keeping the edited variable's transform.
			const at = insertIdx;
			const transform = editOriginal?.kind === 'var' ? editOriginal.transform : '';
			const part: VarPart = {
				kind: 'var',
				source: item.varData.source,
				field: item.varData.field,
				transform
			};
			clearPending();
			parts = [...parts.slice(0, at), part, ...parts.slice(at)];
			emit();
		}
		acItems = [];
		acForTransform = false;
		chipInputEl?.focus();
	}

	function handleChipInput(e: Event) {
		const el = e.target as HTMLInputElement;
		currentText = el.value;
		computeChipAc(currentText);
	}

	function handleChipKeydown(e: KeyboardEvent) {
		if (e.key === 'Backspace' && currentText === '') {
			e.preventDefault();
			removePartBeforeInput();
			return;
		}
		if (e.key === 'Escape') {
			if (showAc) acItems = [];
			else settlePending('cancel');
			return;
		}
		if (e.key === 'Enter' && !showAc) {
			e.preventDefault();
			settlePending('commit');
			return;
		}
		if (!showAc) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			acIdx = (acIdx + 1) % acItems.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			acIdx = (acIdx - 1 + acItems.length) % acItems.length;
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			applyAcItem(acItems[acIdx]);
		}
	}

	// ── Focus tracking ─────────────────────────────────────────────────────
	// Only the chip input sets focused=true — NOT onfocusin on the container.
	// This prevents layout shifts (input growing) when the </> button is clicked,
	// which would move the button between mousedown and mouseup causing missed clicks.
	function handleChipInputFocus() {
		focused = true;
		computeChipAc(currentText);
	}

	function handleContainerFocusout(e: FocusEvent) {
		const container = e.currentTarget as HTMLElement;
		if (!container?.contains(e.relatedTarget as Node)) {
			focused = false;
			acItems = [];
			settlePending('commit');
		}
	}

	// ── Raw mode ───────────────────────────────────────────────────────────
	function openRaw() {
		settlePending('commit');
		acItems = [];
		rawText = serializeParts(parts);
		rawMode = true;
		setTimeout(() => rawInputEl?.focus(), 0);
	}

	function closeRaw() {
		parts = parseValue(rawText);
		rawMode = false;
		if (rawText !== lastValue) {
			lastValue = rawText;
			onchange(rawText);
		}
		setTimeout(() => chipInputEl?.focus(), 0);
	}

	function toggleRaw() {
		if (rawMode) closeRaw();
		else openRaw();
	}

	function handleRawInput(e: Event) {
		rawText = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
		lastValue = rawText;
		onchange(rawText);
	}

	function handleRawKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			parts = parseValue(rawText);
			rawMode = false;
		}
	}
</script>

{#if multiline}
	<textarea
		class="textarea textarea-xs w-full font-mono text-xs leading-relaxed"
		{rows}
		placeholder={placeholder || 'expression or value'}
		value={rawText}
		oninput={handleRawInput}></textarea>
{:else if rawMode}
	<div class="flex items-center gap-1">
		<input
			bind:this={rawInputEl}
			class="input input-xs min-w-0 flex-1 font-mono"
			type="text"
			placeholder={'${ expression }'}
			value={rawText}
			oninput={handleRawInput}
			onkeydown={handleRawKeydown}
		/>
		<button
			type="button"
			class="btn btn-ghost btn-xs shrink-0 px-1.5 font-mono text-[9px] opacity-50 hover:opacity-100"
			onclick={toggleRaw}
			title="Switch to visual chip view">chip</button
		>
	</div>
{:else}
	<!-- Chip-token input -->
	<div class="relative">
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="border-base-300 bg-base-100 flex min-h-6.5 w-full cursor-text flex-wrap items-center gap-0.5 rounded-lg border px-1.5 py-0.5 transition-colors focus-within:border-primary/40"
			role="group"
			aria-label="Expression builder"
			onfocusout={handleContainerFocusout}
			onclick={(e) => {
				if (e.target === e.currentTarget) chipInputEl?.focus();
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter' && e.target === e.currentTarget) chipInputEl?.focus();
			}}
		>
			<!-- Chips sit at odd flex orders; the text input takes the even order of its slot. -->
			{#each parts as part, i (i)}
				<span class="inline-flex items-center gap-0.5" style:order={i * 2 + 1}>
					{#if i > 0 || editIdx === 0}
						<span class="select-none font-mono text-[9px] text-base-content/25">+</span>
					{/if}
					{#if part.kind === 'var'}
						{@const vp = part as VarPart}
						<span
							class="group/chip inline-flex items-center gap-0.5 rounded bg-base-200 px-1 py-0.5"
						>
							<!-- Clickable edit area -->
							<span
								class="inline-flex cursor-pointer items-center gap-0.5 leading-none"
								role="button"
								tabindex="0"
								onclick={() => editChip(i)}
								onkeydown={(e) => e.key === 'Enter' && editChip(i)}
								title="Click to edit"
							>
								<span
									class="flex size-4 shrink-0 items-center justify-center rounded font-mono text-[8px] font-bold text-white"
									style:background={srcColor(vp.source)}>{SRC_LETTER[vp.source] ?? '?'}</span
								>
								<span
									class="max-w-24 truncate font-mono text-[10px] text-base-content/80"
									title={vp.field || vp.source}
								>
									{trunc(vp.field || vp.source)}
								</span>
								{#if vp.transform}
									<span class="font-mono text-[9px] text-base-content/40">{vp.transform}</span>
								{/if}
							</span>
							<!-- Remove button -->
							<button
								type="button"
								class="ml-0.5 px-0.5 text-xs leading-none text-base-content/40 transition-colors hover:text-error"
								onclick={() => removePart(i)}
								aria-label="Remove">×</button
							>
						</span>
					{:else}
						{@const lp = part as LiteralPart}
						{#if isExprLiteral(lp.text)}
							<!-- Complex jq expression chip — click to edit in raw mode -->
							<span
								class="group/chip inline-flex items-center gap-0.5 rounded border border-base-300 bg-base-200/60 px-1 py-0.5"
							>
								<span class="shrink-0 font-mono text-[8px] text-base-content/30">&lt;/&gt;</span>
								<span
									class="max-w-28 cursor-pointer truncate font-mono text-[10px] italic text-base-content/60"
									role="button"
									tabindex="0"
									onclick={() => editChip(i)}
									onkeydown={(e) => e.key === 'Enter' && editChip(i)}
									title={lp.text}>{trunc(exprInner(lp.text), 22)}</span
								>
								<button
									type="button"
									class="ml-0.5 px-0.5 text-xs leading-none text-base-content/40 transition-colors hover:text-error"
									onclick={() => removePart(i)}
									aria-label="Remove">×</button
								>
							</span>
						{:else}
							{@const lpLabel = '"' + trunc(lp.text) + '"'}
							<span class="group/chip inline-flex items-center gap-0 text-base-content/50">
								<span
									class="cursor-pointer font-mono text-[10px]"
									role="button"
									tabindex="0"
									onclick={() => editChip(i)}
									onkeydown={(e) => e.key === 'Enter' && editChip(i)}
									title={lp.text}>{lpLabel}</span
								>
								<button
									type="button"
									class="px-0.5 text-xs leading-none text-base-content/40 transition-colors hover:text-error"
									onclick={() => removePart(i)}
									aria-label="Remove">×</button
								>
							</span>
						{/if}
					{/if}
				</span>
			{/each}

			<!-- + before the input when it follows a chip (appending, or editing a non-first chip) -->
			{#if focused && insertIdx > 0}
				<span
					class="select-none font-mono text-[9px] text-base-content/25"
					style:order={insertIdx * 2}>+</span
				>
			{/if}

			<!-- Inline input: visible when focused or no chips yet -->
			<input
				bind:this={chipInputEl}
				type="text"
				class={[
					'bg-transparent font-mono text-[10px] text-base-content outline-none placeholder:text-base-content/20 transition-all',
					!focused && parts.length > 0 ? 'h-px w-px overflow-hidden opacity-0' : 'min-w-12 flex-1'
				].join(' ')}
				style:order={insertIdx * 2}
				placeholder={parts.length === 0 ? placeholder || 'type or select a variable…' : ''}
				value={currentText}
				oninput={handleChipInput}
				onkeydown={handleChipKeydown}
				onfocus={handleChipInputFocus}
				aria-label="Add expression part"
			/>

			<!-- Raw toggle -->
			<button
				type="button"
				class="ml-auto shrink-0 self-center px-1 font-mono text-[10px] text-base-content/40 transition-colors hover:text-primary"
				style:order={parts.length * 2 + 2}
				onclick={toggleRaw}
				title="Edit raw expression">&lt;/&gt;</button
			>
		</div>

		<!-- Autocomplete dropdown -->
		{#if showAc}
			<ul
				class="absolute left-0 top-full z-50 mt-0.5 min-w-52 max-w-80 overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-lg"
			>
				{#if acForTransform}
					<li class="border-b border-base-200 px-2 py-1">
						<span class="text-[9px] font-semibold uppercase tracking-wider text-base-content/40"
							>Transform — applies to {editOriginal?.kind === 'var'
								? 'this variable'
								: 'last variable'}</span
						>
					</li>
				{/if}
				{#each acItems as item, idx (item.label)}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-2 px-2 py-1.5 text-left transition hover:bg-base-200"
							class:bg-base-200={idx === acIdx}
							onmousedown={(e) => {
								e.preventDefault();
								applyAcItem(item);
							}}
						>
							{#if item.source}
								<span
									class="flex size-4 shrink-0 items-center justify-center rounded font-mono text-[8px] font-bold text-white"
									style:background={srcColor(item.source)}>{SRC_LETTER[item.source] ?? '?'}</span
								>
							{:else if item.category === 'transform'}
								<span class="shrink-0 font-mono text-[10px] font-bold text-base-content/40">|</span>
							{/if}
							<code class="min-w-0 flex-1 truncate font-mono text-xs">{item.label}</code>
							{#if item.hint}
								<span class="ml-2 shrink-0 truncate text-[10px] text-base-content/30"
									>{item.hint}</span
								>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
