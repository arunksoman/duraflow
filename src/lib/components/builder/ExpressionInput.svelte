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
	import { Code2, Eye, Plus, Trash2 } from '@lucide/svelte';

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

	// ── Part types ─────────────────────────────────────────────────────────
	type LiteralPart = { kind: 'literal'; text: string };
	type VarPart = { kind: 'var'; source: string; field: string; transform: string };
	type ExprPart = LiteralPart | VarPart;

	interface AcItem {
		label: string;
		insert: string;
		hint: string;
		category: string;
	}

	// ── Constants ──────────────────────────────────────────────────────────
	const TRANSFORMS = [
		{ value: '', label: 'no transform' },
		{ value: '| tostring', label: '| tostring' },
		{ value: '| tonumber', label: '| tonumber' },
		{ value: '| ascii_downcase', label: '| ascii_downcase' },
		{ value: '| ascii_upcase', label: '| ascii_upcase' },
		{ value: '| length', label: '| length' },
		{ value: '| @base64', label: '| @base64' },
		{ value: '| @uri', label: '| @uri' },
		{ value: '| keys', label: '| keys' },
		{ value: '| values', label: '| values' },
		{ value: '| not', label: '| not' },
		{ value: '| floor', label: '| floor' },
		{ value: '| ceil', label: '| ceil' },
		{ value: '| round', label: '| round' },
		{ value: '| abs', label: '| abs' },
		{ value: '| reverse', label: '| reverse' },
		{ value: '| unique', label: '| unique' },
		{ value: '| sort', label: '| sort' },
		{ value: '| first', label: '| first' },
		{ value: '| last', label: '| last' },
		{ value: '| flatten', label: '| flatten' },
		{ value: '| type', label: '| type' }
	];

	interface SrcConfig {
		category: string;
		hasFields: boolean;
	}
	const SRC_CFG: Record<string, SrcConfig> = {
		'$input': { category: 'input', hasFields: true },
		'$env': { category: 'env', hasFields: true },
		'$data': { category: 'data', hasFields: true },
		'$context': { category: 'context', hasFields: false },
		'$output': { category: 'output', hasFields: false },
		'.': { category: 'output', hasFields: false }
	};

	const CAT_COLOR: Record<string, string> = {
		input: 'var(--color-primary)',
		env: 'var(--color-warning)',
		data: 'var(--color-success)',
		context: 'var(--color-info)',
		output: 'var(--color-secondary)'
	};
	const CAT_BADGE: Record<string, string> = {
		input: 'badge-primary',
		env: 'badge-warning',
		data: 'badge-success',
		context: 'badge-info',
		output: 'badge-secondary'
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
			if ('([{'.includes(ch)) { depth++; current += ch; continue; }
			if (')]}'.includes(ch)) { depth--; current += ch; continue; }
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

	function parseValue(val: string): ExprPart[] | null {
		if (!val || val.trim() === '') return [];
		const exprMatch = val.match(/^\$\{\s*([\s\S]+?)\s*\}$/);
		if (!exprMatch) return [{ kind: 'literal', text: val }];
		const inner = exprMatch[1];
		const rawParts = splitOnPlus(inner);
		if (!rawParts) return null;
		const result: ExprPart[] = [];
		for (const raw of rawParts) {
			const t = raw.trim();
			// ($source.field | transform)
			const parenVar = t.match(/^\(\$(\w+)\.(\w+)\s*(\|[^)]+)\)$/);
			if (parenVar) {
				result.push({ kind: 'var', source: '$' + parenVar[1], field: parenVar[2], transform: parenVar[3].trim() });
				continue;
			}
			// $source.field
			const dotVar = t.match(/^\$(\w+)\.(\w+)$/);
			if (dotVar) {
				result.push({ kind: 'var', source: '$' + dotVar[1], field: dotVar[2], transform: '' });
				continue;
			}
			// . shorthand
			if (t === '.') { result.push({ kind: 'var', source: '.', field: '', transform: '' }); continue; }
			// $source (whole object), optionally with transform
			const simpleVar = t.match(/^\$(\w+)(\s*\|.+)?$/);
			if (simpleVar) {
				result.push({ kind: 'var', source: '$' + simpleVar[1], field: '', transform: simpleVar[2]?.trim() ?? '' });
				continue;
			}
			// "string literal"
			const strLit = t.match(/^"(.*)"$/);
			if (strLit) { result.push({ kind: 'literal', text: strLit[1] }); continue; }
			return null;
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
	let mode = $state<'visual' | 'raw'>(_init !== null ? 'visual' : 'raw');
	let parts = $state<ExprPart[]>(_init ?? []);
	let rawText = $state(untrack(() => value));

	// ── Derived ────────────────────────────────────────────────────────────
	const availSources = $derived.by(() => {
		const result: string[] = [];
		for (const v of availVars) {
			if (!result.includes(v.source)) result.push(v.source);
		}
		if (!result.includes('.')) result.push('.');
		return result;
	});

	// ── Helpers ────────────────────────────────────────────────────────────
	function fieldsFor(source: string): AvailVar[] {
		return availVars.filter((v) => v.source === source && v.field);
	}

	function dotColor(source: string): string {
		const cat = SRC_CFG[source]?.category ?? 'output';
		return CAT_COLOR[cat] ?? 'currentColor';
	}

	// ── Part mutations ─────────────────────────────────────────────────────
	function emit() { onchange(serializeParts(parts)); }

	function addVarPart() {
		const src = availSources[0] ?? '$input';
		const avs = fieldsFor(src);
		parts = [...parts, { kind: 'var', source: src, field: avs[0]?.field ?? '', transform: '' }];
		emit();
	}

	function addLiteralPart() {
		parts = [...parts, { kind: 'literal', text: '' }];
		emit();
	}

	function removePart(i: number) {
		parts = parts.filter((_, j) => j !== i);
		emit();
	}

	function updateVarSource(i: number, src: string) {
		const cfg = SRC_CFG[src];
		const avs = fieldsFor(src);
		const newField = cfg?.hasFields ? (avs[0]?.field ?? '') : '';
		parts = parts.map((p, j) => j === i ? { kind: 'var', source: src, field: newField, transform: '' } : p);
		emit();
	}

	function updateVarField(i: number, field: string) {
		parts = parts.map((p, j) => j === i ? { ...p, field } : p);
		emit();
	}

	function updateVarTransform(i: number, transform: string) {
		parts = parts.map((p, j) => j === i ? { ...p, transform } : p);
		emit();
	}

	function updateLiteralText(i: number, text: string) {
		parts = parts.map((p, j) => j === i ? { kind: 'literal', text } : p);
		emit();
	}

	// ── Mode toggle ────────────────────────────────────────────────────────
	function switchToRaw() {
		rawText = serializeParts(parts);
		mode = 'raw';
	}

	function switchToVisual() {
		const parsed = parseValue(rawText);
		if (parsed !== null) { parts = parsed; mode = 'visual'; }
	}

	// ── Autocomplete ───────────────────────────────────────────────────────
	let inputRef = $state<HTMLInputElement | null>(null);
	let textareaRef = $state<HTMLTextAreaElement | null>(null);
	let acItems = $state<AcItem[]>([]);
	let acIdx = $state(0);
	let acReplaceFrom = $state(0);
	let acReplaceTo = $state(0);

	const showAc = $derived(acItems.length > 0);

	function computeAc(text: string, cursor: number) {
		const before = text.slice(0, cursor);

		// | transform
		const pipeM = before.match(/\|\s*(\w*)$/);
		if (pipeM) {
			const q = pipeM[1].toLowerCase();
			acItems = TRANSFORMS
				.filter((t) => t.value && t.value.slice(2).toLowerCase().startsWith(q))
				.map((t) => ({ label: t.value.slice(2), insert: t.value.slice(2), hint: '', category: 'transform' }))
				.slice(0, 10);
			acReplaceFrom = cursor - pipeM[1].length;
			acReplaceTo = cursor;
			acIdx = 0;
			return;
		}

		// $source.field
		const fieldM = before.match(/\$(\w+)\.(\w*)$/);
		if (fieldM) {
			const src = '$' + fieldM[1];
			const q = fieldM[2].toLowerCase();
			acItems = fieldsFor(src)
				.filter((v) => v.field.toLowerCase().startsWith(q))
				.map((v) => ({ label: v.field, insert: v.field, hint: v.hint, category: v.category }))
				.slice(0, 10);
			acReplaceFrom = cursor - fieldM[2].length;
			acReplaceTo = cursor;
			acIdx = 0;
			return;
		}

		// $source
		const srcM = before.match(/\$(\w*)$/);
		if (srcM) {
			const q = srcM[1].toLowerCase();
			acItems = ['input', 'env', 'data', 'context', 'output']
				.filter((s) => s.startsWith(q))
				.map((s) => ({ label: '$' + s, insert: '$' + s, hint: '', category: s }));
			acReplaceFrom = cursor - srcM[0].length;
			acReplaceTo = cursor;
			acIdx = 0;
			return;
		}

		acItems = [];
	}

	function handleRawInput(e: Event) {
		const el = e.target as HTMLInputElement;
		rawText = el.value;
		onchange(rawText);
		computeAc(rawText, el.selectionStart ?? rawText.length);
	}

	function applyAcItem(item: AcItem) {
		const el = (inputRef ?? textareaRef) as HTMLInputElement | null;
		if (!el) return;
		const before = rawText.slice(0, acReplaceFrom);
		const after = rawText.slice(acReplaceTo);
		rawText = before + item.insert + after;
		onchange(rawText);
		acItems = [];
		requestAnimationFrame(() => {
			const pos = acReplaceFrom + item.insert.length;
			(el as HTMLInputElement).setSelectionRange(pos, pos);
			el.focus();
		});
	}

	function handleRawKeydown(e: KeyboardEvent) {
		if (!showAc) return;
		if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = (acIdx + 1) % acItems.length; }
		else if (e.key === 'ArrowUp') { e.preventDefault(); acIdx = (acIdx - 1 + acItems.length) % acItems.length; }
		else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyAcItem(acItems[acIdx]); }
		else if (e.key === 'Escape') { acItems = []; }
	}
</script>

<div class="flex flex-col gap-1">
	<!-- Mode toggle -->
	<div class="flex items-center justify-end">
		{#if mode === 'visual'}
			<button
				type="button"
				class="btn btn-ghost btn-xs gap-1 text-[10px] opacity-40 hover:opacity-100"
				onclick={switchToRaw}
				title="Switch to raw gojq expression mode"
			>
				<Code2 size={10} />Raw
			</button>
		{:else}
			<button
				type="button"
				class="btn btn-ghost btn-xs gap-1 text-[10px] opacity-40 hover:opacity-100"
				onclick={switchToVisual}
				title="Switch to visual builder mode"
			>
				<Eye size={10} />Visual
			</button>
		{/if}
	</div>

	{#if mode === 'visual'}
		<!-- Visual part builder -->
		<div class="flex flex-col gap-1">
			{#each parts as part, i (i)}
				{#if i > 0}
					<div class="text-base-content/25 text-center font-mono text-[10px]">+</div>
				{/if}

				<div class="flex items-center gap-1">
					{#if part.kind === 'literal'}
						{@const lp = part as LiteralPart}
						<span class="badge badge-ghost badge-xs shrink-0 font-mono text-[9px]">"…"</span>
						<input
							class="input input-xs min-w-0 flex-1"
							placeholder="literal text"
							value={lp.text}
							oninput={(e) => updateLiteralText(i, (e.target as HTMLInputElement).value)}
						/>
					{:else}
						{@const vp = part as VarPart}
						{@const cfg = SRC_CFG[vp.source] ?? { category: 'output', hasFields: false }}
						<!-- colored dot indicator -->
						<span
							class="size-2 shrink-0 rounded-full"
							style:background={dotColor(vp.source)}
							aria-hidden="true"
						></span>
						<!-- source selector -->
						<select
							class="select select-xs w-20 shrink-0 font-mono text-[10px]"
							value={vp.source}
							onchange={(e) => updateVarSource(i, (e.target as HTMLSelectElement).value)}
						>
							{#each availSources as src (src)}
								<option value={src}>{src}</option>
							{/each}
						</select>
						<!-- field selector -->
						{#if cfg.hasFields}
							{@const avs = fieldsFor(vp.source)}
							{#if avs.length > 0}
								<select
									class="select select-xs min-w-0 flex-1 font-mono text-[10px]"
									value={vp.field}
									onchange={(e) => updateVarField(i, (e.target as HTMLSelectElement).value)}
								>
									{#each avs as av (av.field)}
										<option value={av.field} title={av.hint}>{av.field}</option>
									{/each}
								</select>
							{:else}
								<input
									class="input input-xs min-w-0 flex-1 font-mono text-[10px]"
									placeholder="field"
									value={vp.field}
									oninput={(e) => updateVarField(i, (e.target as HTMLInputElement).value)}
								/>
							{/if}
						{:else}
							<span class="text-base-content/30 flex-1 pl-1 text-[10px] italic">whole value</span>
						{/if}
						<!-- transform selector -->
						<select
							class="select select-xs w-24 shrink-0 font-mono text-[10px]"
							value={vp.transform}
							onchange={(e) => updateVarTransform(i, (e.target as HTMLSelectElement).value)}
						>
							{#each TRANSFORMS as t (t.value)}
								<option value={t.value}>{t.label}</option>
							{/each}
						</select>
					{/if}
					<button
						type="button"
						class="btn btn-ghost btn-xs btn-circle text-error shrink-0"
						onclick={() => removePart(i)}
						aria-label="Remove"
					>
						<Trash2 size={9} />
					</button>
				</div>
			{/each}

			<!-- Add buttons -->
			<div class="flex gap-1 pt-0.5">
				<button
					type="button"
					class="btn btn-ghost btn-xs gap-1 text-[10px]"
					onclick={addVarPart}
				>
					<Plus size={9} />Variable
				</button>
				<button
					type="button"
					class="btn btn-ghost btn-xs gap-1 text-[10px]"
					onclick={addLiteralPart}
				>
					<Plus size={9} />Text
				</button>
			</div>

			<!-- Expression preview -->
			{#if parts.length > 0}
				{@const preview = serializeParts(parts)}
				{#if preview}
					<p class="text-base-content/25 break-all font-mono text-[9px]">{preview}</p>
				{/if}
			{:else if placeholder}
				<p class="text-base-content/30 text-[10px] italic">{placeholder}</p>
			{/if}
		</div>

	{:else}
		<!-- Raw mode with autocomplete -->
		<div class="relative">
			{#if multiline}
				<textarea
					bind:this={textareaRef}
					class="textarea textarea-xs w-full font-mono text-xs leading-relaxed"
					{rows}
					placeholder={placeholder || '${ expression }'}
					value={rawText}
					oninput={handleRawInput}
					onkeydown={handleRawKeydown}
					onblur={() => setTimeout(() => { acItems = []; }, 150)}
				></textarea>
			{:else}
				<input
					bind:this={inputRef}
					class="input input-xs w-full font-mono"
					type="text"
					placeholder={placeholder || '${ expression }'}
					value={rawText}
					oninput={handleRawInput}
					onkeydown={handleRawKeydown}
					onblur={() => setTimeout(() => { acItems = []; }, 150)}
				/>
			{/if}

			{#if showAc}
				<ul
					class="bg-base-100 border-base-300 absolute left-0 top-full z-50 mt-0.5 min-w-48 max-w-70 overflow-hidden rounded-lg border shadow-lg"
				>
					{#each acItems as item, idx (item.label)}
						<li>
							<button
								type="button"
								class="hover:bg-base-200 flex w-full items-center gap-2 px-2 py-1 text-left transition"
								class:bg-base-200={idx === acIdx}
								onmousedown={(e) => { e.preventDefault(); applyAcItem(item); }}
							>
								{#if item.category && item.category !== 'transform'}
									<span class="badge badge-xs shrink-0 {CAT_BADGE[item.category] ?? 'badge-ghost'}">
										{item.category}
									</span>
								{/if}
								<code class="font-mono text-xs">{item.label}</code>
								{#if item.hint}
									<span class="text-base-content/30 ml-auto truncate text-[10px]">{item.hint}</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
