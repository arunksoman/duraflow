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

	function parseSingleToken(t: string): ExprPart | null {
		const parenVar = t.match(/^\(\$(\w+)\.(\w+)\s*(\|[^)]+)\)$/);
		if (parenVar)
			return {
				kind: 'var',
				source: '$' + parenVar[1],
				field: parenVar[2],
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
		const strLit = t.match(/^"(.*)"$/s);
		if (strLit) return { kind: 'literal', text: strLit[1] };
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
			if (p.kind === 'literal') return '"' + (p as LiteralPart).text + '"';
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

	const showAc = $derived(acItems.length > 0);

	// ── Helpers ────────────────────────────────────────────────────────────
	function srcColor(source: string): string {
		return CAT_COLOR[SRC_CAT[source] ?? 'output'] ?? 'currentColor';
	}

	function trunc(s: string, max = 16): string {
		return s.length > max ? s.slice(0, max - 1) + '…' : s;
	}

	function emit() {
		onchange(serializeParts(parts));
	}

	// ── Chip mutations ─────────────────────────────────────────────────────
	function removePart(i: number) {
		parts = parts.filter((_, j) => j !== i);
		emit();
		chipInputEl?.focus();
	}

	function removeLastPart() {
		if (parts.length > 0) {
			parts = parts.slice(0, -1);
			emit();
		}
	}

	function commitCurrentAsLiteral() {
		const text = currentText.trim();
		if (!text || text === '|') {
			currentText = '';
			if (chipInputEl) chipInputEl.value = '';
			return;
		}
		parts = [...parts, { kind: 'literal', text }];
		currentText = '';
		if (chipInputEl) chipInputEl.value = '';
		emit();
	}

	function isExprLiteral(text: string): boolean {
		return /^\$\{[\s\S]*\}$/.test(text.trim());
	}

	function editChip(i: number) {
		const part = parts[i];
		parts = parts.filter((_, j) => j !== i);
		if (part.kind === 'literal' && isExprLiteral((part as LiteralPart).text)) {
			// Complex expression-literal: open in raw mode for editing
			rawText = (part as LiteralPart).text;
			rawMode = true;
			emit();
			setTimeout(() => rawInputEl?.focus(), 0);
			return;
		}
		const txt =
			part.kind === 'var'
				? (part as VarPart).field || (part as VarPart).source.replace(/^\$/, '')
				: (part as LiteralPart).text;
		currentText = txt;
		if (chipInputEl) {
			chipInputEl.value = txt;
			chipInputEl.focus();
		}
		computeChipAc(txt);
		emit();
	}

	// ── Autocomplete ───────────────────────────────────────────────────────
	function computeChipAc(text: string) {
		if (text === '|') {
			const hasLastVar = parts.some((p) => p.kind === 'var');
			if (hasLastVar) {
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
			let lastVarIdx = -1;
			for (let i = parts.length - 1; i >= 0; i--) {
				if (parts[i].kind === 'var') {
					lastVarIdx = i;
					break;
				}
			}
			if (lastVarIdx >= 0) {
				parts = parts.map((p, i) =>
					i === lastVarIdx ? { ...p, transform: '| ' + item.insert } : p
				) as ExprPart[];
				emit();
			}
			currentText = '';
			if (chipInputEl) chipInputEl.value = '';
		} else if (item.varData) {
			// currentText is the search term used to find the variable — discard it,
			// don't commit as a literal chip.
			parts = [
				...parts,
				{ kind: 'var', source: item.varData.source, field: item.varData.field, transform: '' }
			];
			currentText = '';
			if (chipInputEl) chipInputEl.value = '';
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
			removeLastPart();
			return;
		}
		if (e.key === 'Enter' && !showAc) {
			e.preventDefault();
			commitCurrentAsLiteral();
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
		} else if (e.key === 'Escape') {
			acItems = [];
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
			if (currentText.trim() && currentText !== '|') commitCurrentAsLiteral();
			acItems = [];
		}
	}

	// ── Raw mode ───────────────────────────────────────────────────────────
	function toggleRaw() {
		if (!rawMode) {
			rawText = serializeParts(parts);
			rawMode = true;
			setTimeout(() => rawInputEl?.focus(), 0);
		} else {
			parts = parseValue(rawText);
			rawMode = false;
			onchange(rawText);
			setTimeout(() => chipInputEl?.focus(), 0);
		}
	}

	function handleRawInput(e: Event) {
		rawText = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
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
			{#each parts as part, i (i)}
				{#if i > 0}
					<span class="select-none font-mono text-[9px] text-base-content/25">+</span>
				{/if}
				{#if part.kind === 'var'}
					{@const vp = part as VarPart}
					<span class="group/chip inline-flex items-center gap-0.5 rounded bg-base-200 px-1 py-0.5">
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
							class="ml-0.5 leading-none text-base-content/20 opacity-0 transition-opacity hover:text-error group-hover/chip:opacity-100"
							onclick={() => removePart(i)}
							aria-label="Remove">×</button
						>
					</span>
				{:else}
					{@const lp = part as LiteralPart}
					{#if isExprLiteral(lp.text)}
						<!-- Complex jq expression chip — click to edit in raw mode -->
						{@const inner = lp.text.replace(/^\$\{\s*/, '').replace(/\s*\}$/, '')}
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
								title={lp.text}>{trunc(inner, 22)}</span
							>
							<button
								type="button"
								class="ml-0.5 leading-none text-base-content/20 opacity-0 transition-opacity hover:text-error group-hover/chip:opacity-100"
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
								class="leading-none text-base-content/20 opacity-0 transition-opacity hover:text-error group-hover/chip:opacity-100"
								onclick={() => removePart(i)}
								aria-label="Remove">×</button
							>
						</span>
					{/if}
				{/if}
			{/each}

			<!-- Trailing + only when focused and chips exist -->
			{#if focused && parts.length > 0}
				<span class="select-none font-mono text-[9px] text-base-content/25">+</span>
			{/if}

			<!-- Inline input: visible when focused or no chips yet -->
			<input
				bind:this={chipInputEl}
				type="text"
				class={[
					'bg-transparent font-mono text-[10px] text-base-content outline-none placeholder:text-base-content/20 transition-all',
					!focused && parts.length > 0 ? 'h-px w-px overflow-hidden opacity-0' : 'min-w-12 flex-1'
				].join(' ')}
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
				class="ml-auto shrink-0 self-center px-0.5 font-mono text-[8px] text-base-content/20 transition-colors hover:text-base-content/60"
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
							>Transform — applies to last variable</span
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
