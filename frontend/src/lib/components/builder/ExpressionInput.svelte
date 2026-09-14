<script lang="ts" module>
	import type { VarSource } from '$lib/zigflow-engine/expression';

	/** Badge colour per variable source — shared with anything else that shows a variable chip. */
	export const SOURCE_COLOR: Record<VarSource, string> = {
		input: 'var(--color-primary)',
		data: 'var(--color-success)',
		context: 'var(--color-info)',
		output: 'var(--color-secondary)',
		env: 'var(--color-warning)',
		dot: 'var(--color-neutral)'
	};
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import type { AvailVar } from './availableVars';
	import {
		parseExpression,
		parsePathText,
		parseRef,
		parseTransforms,
		pathToText,
		refToJq,
		serializeExpression,
		SOURCE_LABEL,
		SOURCE_LETTER,
		TRANSFORMS,
		VAR_SOURCES,
		type ExprMode,
		type ExprToken,
		type VarToken
	} from '$lib/zigflow-engine/expression';

	interface Props {
		value: string;
		placeholder?: string;
		multiline?: boolean;
		rows?: number;
		availVars: AvailVar[];
		/**
		 * `template` (default): the value is plain text or one `${ }` runtime expression.
		 * `jq`: the value is bare jq — used for condition operands.
		 */
		mode?: ExprMode;
		onchange: (val: string) => void;
	}

	let {
		value,
		placeholder = '',
		multiline = false,
		rows = 3,
		availVars,
		mode = 'template',
		onchange
	}: Props = $props();

	type AcItem =
		| { kind: 'var'; v: AvailVar }
		| { kind: 'ref'; token: VarToken }
		| { kind: 'transform'; name: string; hint: string }
		| { kind: 'literal'; text: string };

	const LETTER_SOURCE = Object.fromEntries(
		VAR_SOURCES.filter((s) => s !== 'dot').map((s) => [SOURCE_LETTER[s].toLowerCase(), s])
	) as Record<string, VarToken['source']>;

	// ── State ──────────────────────────────────────────────────────────────
	// The field is controlled by `value`, but re-parsing on every keystroke would throw away
	// in-progress chip edits. So: remember what this field last emitted, and only re-parse when the
	// incoming value is something else (a different node, a row above was removed, DSL applied).
	let lastEmitted = untrack(() => value);
	let tokens = $state<ExprToken[]>(untrack(() => parseExpression(value, mode)));
	let rawMode = $state(false);
	let rawText = $state(untrack(() => value));
	let draft = $state('');
	let focused = $state(false);
	let acItems = $state<AcItem[]>([]);
	let acIdx = $state(0);
	let editIdx = $state<number | null>(null);
	let editPath = $state('');
	let editTransforms = $state('');

	let chipInputEl = $state<HTMLInputElement | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);

	$effect(() => {
		const incoming = value;
		untrack(() => {
			if (incoming === lastEmitted) return;
			lastEmitted = incoming;
			tokens = parseExpression(incoming, mode);
			rawText = incoming;
			editIdx = null;
		});
	});

	const lastVar = $derived.by(() => {
		const last = tokens[tokens.length - 1];
		return last?.kind === 'var' ? last : null;
	});
	const pathValid = $derived(parsePathText(editPath) !== null);
	const transformsValid = $derived(parseTransforms(editTransforms) !== null);

	function emitValue(next: string) {
		lastEmitted = next;
		onchange(next);
	}

	function emit() {
		emitValue(serializeExpression(tokens, mode));
	}

	function varLabel(t: { source: VarToken['source']; path: VarToken['path'] }): string {
		const p = pathToText(t.path);
		return p || (t.source === 'dot' ? '.' : `$${t.source}`);
	}

	// ── Token mutations ────────────────────────────────────────────────────
	function pushToken(tok: ExprToken) {
		tokens = [...tokens, tok];
		draft = '';
		emit();
	}

	function removeToken(i: number) {
		tokens = tokens.filter((_, j) => j !== i);
		if (editIdx === i) editIdx = null;
		emit();
		chipInputEl?.focus();
	}

	function commitDraft() {
		const text = draft.trim();
		if (!text || text === '|') {
			draft = '';
			return;
		}
		const ref = parseRef(text);
		if (ref) {
			pushToken({ kind: 'var', source: ref.source, path: ref.path, transforms: [] });
		} else if (/^\$\{[\s\S]*\}$/.test(text)) {
			tokens = [...tokens, ...parseExpression(text, 'template')];
			draft = '';
			emit();
		} else if (mode === 'jq' && /^(-?\d+(\.\d+)?|true|false|null)$/.test(text)) {
			// A bare jq scalar is a value, not the string "3".
			pushToken({ kind: 'raw', expr: text });
		} else {
			pushToken({ kind: 'literal', text: draft });
		}
	}

	// ── Autocomplete ───────────────────────────────────────────────────────
	function varItems(filter: (v: AvailVar) => boolean, limit: number): AcItem[] {
		return availVars
			.filter(filter)
			.slice(0, limit)
			.map((v) => ({ kind: 'var', v }));
	}

	function computeAc(text: string) {
		acIdx = 0;
		if (text.startsWith('|')) {
			if (!lastVar) {
				acItems = [];
				return;
			}
			const q = text.slice(1).trim().toLowerCase();
			const matches: AcItem[] = TRANSFORMS.filter(
				(t) => !q || t.name.toLowerCase().includes(q) || t.hint.includes(q)
			)
				.slice(0, 10)
				.map((t) => ({ kind: 'transform', name: t.name, hint: t.hint }));
			const custom = text.slice(1).trim();
			if (custom && parseTransforms(custom) && !TRANSFORMS.some((t) => t.name === custom)) {
				matches.unshift({ kind: 'transform', name: custom, hint: 'custom' });
			}
			acItems = matches;
			return;
		}

		const t = text.trim();
		if (!t) {
			acItems = varItems(() => true, 12);
			return;
		}

		// `$data.us…` / `.sta…` — prefix match on the reference itself.
		if (t.startsWith('$') || t.startsWith('.')) {
			const items = varItems((v) => refToJq(v.source, v.path).startsWith(t), 8);
			const ref = parseRef(t);
			// The typed reference is the fallback: Enter picks a matching known variable first.
			if (ref && !availVars.some((v) => refToJq(v.source, v.path) === t)) {
				items.push({
					kind: 'ref',
					token: { kind: 'var', source: ref.source, path: ref.path, transforms: [] }
				});
			}
			acItems = items;
			return;
		}

		if (t.startsWith('"')) {
			acItems = [{ kind: 'literal', text: t.replace(/^"|"$/g, '') }];
			return;
		}

		// Letter shortcut from the chip badges: `d:user`, `i.userId`, `e:` …
		const letter = /^([idcoe])[:.](.*)$/i.exec(t);
		if (letter) {
			const source = LETTER_SOURCE[letter[1].toLowerCase()];
			const rest = letter[2].trim();
			const items = varItems(
				(v) =>
					v.source === source && pathToText(v.path).toLowerCase().startsWith(rest.toLowerCase()),
				8
			);
			const path = parsePathText(rest);
			if (
				rest &&
				path &&
				!availVars.some((v) => v.source === source && pathToText(v.path) === pathToText(path))
			) {
				items.push({ kind: 'ref', token: { kind: 'var', source, path, transforms: [] } });
			}
			acItems = items;
			return;
		}

		const q = t.toLowerCase();
		acItems = [
			...varItems(
				(v) =>
					pathToText(v.path).toLowerCase().includes(q) ||
					(v.path.length === 0 && v.source.includes(q)),
				8
			),
			{ kind: 'literal', text: draft }
		];
	}

	function applyAc(item: AcItem) {
		if (item.kind === 'transform') {
			const stages = parseTransforms(item.name);
			if (lastVar && stages) {
				const idx = tokens.length - 1;
				tokens = tokens.map((tok, i) =>
					i === idx && tok.kind === 'var'
						? { ...tok, transforms: [...tok.transforms, ...stages] }
						: tok
				);
				emit();
			}
			draft = '';
		} else if (item.kind === 'var') {
			pushToken({ kind: 'var', source: item.v.source, path: [...item.v.path], transforms: [] });
		} else if (item.kind === 'ref') {
			pushToken(item.token);
		} else {
			pushToken({ kind: 'literal', text: item.text });
		}
		acItems = [];
		chipInputEl?.focus();
	}

	function handleDraftInput(e: Event) {
		draft = (e.target as HTMLInputElement).value;
		computeAc(draft);
	}

	function handleDraftKeydown(e: KeyboardEvent) {
		const showAc = acItems.length > 0;
		if (e.key === 'Backspace' && draft === '') {
			e.preventDefault();
			if (tokens.length > 0) removeToken(tokens.length - 1);
			return;
		}
		if (e.key === 'Enter' && !showAc) {
			e.preventDefault();
			commitDraft();
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
			applyAc(acItems[acIdx]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			acItems = [];
		}
	}

	function handleDraftFocus() {
		focused = true;
		editIdx = null;
		computeAc(draft);
	}

	function handleWrapperFocusout(e: FocusEvent) {
		const wrapper = e.currentTarget as HTMLElement;
		if (wrapper.contains(e.relatedTarget as Node)) return;
		focused = false;
		acItems = [];
		editIdx = null;
		if (draft.trim() && draft.trim() !== '|') commitDraft();
	}

	// ── Chip editor ────────────────────────────────────────────────────────
	function openEditor(i: number) {
		const tok = tokens[i];
		acItems = [];
		editIdx = i;
		if (tok.kind === 'var') {
			editPath = pathToText(tok.path);
			editTransforms = tok.transforms.join(' | ');
		}
	}

	function closeEditor() {
		editIdx = null;
		chipInputEl?.focus();
	}

	function patchToken(i: number, next: ExprToken) {
		tokens = tokens.map((tok, j) => (j === i ? next : tok));
		emit();
	}

	function editVar(i: number, patch: Partial<VarToken>) {
		const tok = tokens[i];
		if (tok?.kind === 'var') patchToken(i, { ...tok, ...patch });
	}

	function onEditPath(i: number, text: string) {
		editPath = text;
		const path = parsePathText(text);
		if (path) editVar(i, { path });
	}

	function onEditTransforms(i: number, text: string) {
		editTransforms = text;
		const stages = parseTransforms(text);
		if (stages) editVar(i, { transforms: stages });
	}

	function appendTransform(i: number, name: string) {
		const tok = tokens[i];
		const stages = parseTransforms(name);
		if (tok?.kind !== 'var' || !stages) return;
		const transforms = [...tok.transforms, ...stages];
		editTransforms = transforms.join(' | ');
		editVar(i, { transforms });
	}

	function editorKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' || (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement))) {
			e.preventDefault();
			closeEditor();
		}
	}

	// ── Raw mode ───────────────────────────────────────────────────────────
	function toggleRaw() {
		if (!rawMode) {
			rawText = serializeExpression(tokens, mode);
			rawMode = true;
		} else {
			tokens = parseExpression(rawText, mode);
			rawMode = false;
			setTimeout(() => chipInputEl?.focus(), 0);
		}
	}

	function handleRawInput(e: Event) {
		rawText = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
		emitValue(rawText);
	}

	// ── Multiline (free text with variable insertion) ──────────────────────
	let insertOpen = $state(false);

	function insertVar(v: AvailVar) {
		const ref = refToJq(v.source, v.path);
		const snippet = mode === 'jq' ? ref : `\${ ${ref} }`;
		const el = textareaEl;
		const start = el?.selectionStart ?? rawText.length;
		const end = el?.selectionEnd ?? rawText.length;
		rawText = rawText.slice(0, start) + snippet + rawText.slice(end);
		emitValue(rawText);
		insertOpen = false;
		setTimeout(() => {
			el?.focus();
			el?.setSelectionRange(start + snippet.length, start + snippet.length);
		}, 0);
	}

	const editing = $derived(editIdx !== null ? tokens[editIdx] : undefined);
</script>

{#snippet badge(source: VarToken['source'], size = 'size-4')}
	<span
		class="flex {size} shrink-0 items-center justify-center font-mono text-[9px] font-bold text-white"
		style:background={SOURCE_COLOR[source]}
		title={SOURCE_LABEL[source]}>{SOURCE_LETTER[source]}</span
	>
{/snippet}

{#if multiline}
	<div
		class="relative"
		onfocusout={(e) => {
			if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) insertOpen = false;
		}}
	>
		<textarea
			bind:this={textareaEl}
			class="textarea textarea-xs w-full pr-8 font-mono text-xs leading-relaxed"
			{rows}
			placeholder={placeholder || 'expression or value'}
			value={rawText}
			oninput={handleRawInput}></textarea>
		<button
			type="button"
			class="btn btn-ghost btn-xs absolute top-1 right-1 px-1 font-mono text-[10px] text-base-content/50"
			title="Insert variable"
			aria-expanded={insertOpen}
			onclick={() => (insertOpen = !insertOpen)}>{'{x}'}</button
		>
		{#if insertOpen}
			<div
				class="border-base-300 bg-base-100 absolute top-7 right-1 z-50 max-h-64 w-64 overflow-y-auto rounded-lg border shadow-lg"
				role="listbox"
				tabindex="-1"
			>
				{#each availVars as v (refToJq(v.source, v.path))}
					<button
						type="button"
						role="option"
						aria-selected="false"
						class="hover:bg-base-200 flex w-full items-center gap-2 px-2 py-1 text-left"
						onmousedown={(e) => e.preventDefault()}
						onclick={() => insertVar(v)}
					>
						<span class="overflow-hidden rounded">{@render badge(v.source)}</span>
						<code class="min-w-0 flex-1 truncate text-[11px]">{varLabel(v)}</code>
						<span class="text-base-content/30 truncate text-[10px]">{v.hint}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
{:else if rawMode}
	<div class="flex items-center gap-1">
		<input
			class="input input-xs min-w-0 flex-1 font-mono"
			type="text"
			placeholder={mode === 'jq' ? 'jq expression' : '${ expression }'}
			value={rawText}
			oninput={handleRawInput}
			onkeydown={(e) => {
				if (e.key === 'Escape' || e.key === 'Enter') {
					e.preventDefault();
					toggleRaw();
				}
			}}
			{@attach (el) => (el as HTMLInputElement).focus()}
		/>
		<button
			type="button"
			class="text-base-content/40 hover:text-base-content/80 shrink-0 px-1 font-mono text-[9px]"
			onclick={toggleRaw}
			title="Back to the visual builder">visual</button
		>
	</div>
{:else}
	<div class="relative" onfocusout={handleWrapperFocusout}>
		<!-- Clicking the field's empty space focuses the text input; the input itself is keyboard-reachable. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<div
			class="border-base-300 bg-base-100 focus-within:border-primary/40 flex min-h-6.5 w-full cursor-text flex-wrap items-center gap-1 rounded-lg border px-1.5 py-0.5 transition-colors"
			role="group"
			aria-label="Expression builder"
			onclick={(e) => {
				if (e.target === e.currentTarget) chipInputEl?.focus();
			}}
		>
			{#each tokens as tok, i (i)}
				{#if i > 0}
					<span class="text-base-content/25 font-mono text-[9px] select-none">+</span>
				{/if}
				<span
					class={[
						'group/chip border-base-300 bg-base-200/60 inline-flex max-w-full items-stretch overflow-hidden rounded border font-mono text-[10px] leading-4',
						editIdx === i && 'ring-primary/50 ring-1'
					]}
				>
					<span
						class="inline-flex min-w-0 cursor-pointer items-stretch"
						role="button"
						tabindex="0"
						title="Click to edit"
						onclick={() => openEditor(i)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								openEditor(i);
							}
						}}
					>
						{#if tok.kind === 'var'}
							{@render badge(tok.source)}
							<span class="text-base-content/80 max-w-32 truncate px-1">{varLabel(tok)}</span>
							{#if tok.transforms.length > 0}
								<span class="border-base-300 text-base-content/45 max-w-28 truncate border-l px-1"
									>{tok.transforms.join(' | ')}</span
								>
							{/if}
						{:else if tok.kind === 'literal'}
							<span class="text-base-content/60 max-w-40 truncate px-1">"{tok.text}"</span>
						{:else}
							<span class="text-base-content/40 border-base-300 border-r px-1">&lt;/&gt;</span>
							<span class="text-base-content/60 max-w-40 truncate px-1 italic">{tok.expr}</span>
						{/if}
					</span>
					<button
						type="button"
						class="text-base-content/25 hover:text-error px-0.5 opacity-0 transition-opacity group-hover/chip:opacity-100 focus:opacity-100"
						onclick={() => removeToken(i)}
						aria-label="Remove">×</button
					>
				</span>
			{/each}

			<input
				bind:this={chipInputEl}
				type="text"
				class={[
					'text-base-content placeholder:text-base-content/25 bg-transparent font-mono text-[10px] outline-none',
					!focused && tokens.length > 0 ? 'w-2 min-w-0' : 'min-w-16 flex-1'
				]}
				placeholder={tokens.length === 0 ? placeholder || 'type, pick a variable, or $…' : ''}
				value={draft}
				oninput={handleDraftInput}
				onkeydown={handleDraftKeydown}
				onfocus={handleDraftFocus}
				aria-label="Add expression part"
				aria-autocomplete="list"
			/>

			<button
				type="button"
				class="text-base-content/25 hover:text-base-content/70 ml-auto shrink-0 self-center px-0.5 font-mono text-[8px] transition-colors"
				onclick={toggleRaw}
				title="Edit as raw text">&lt;/&gt;</button
			>
		</div>

		<!-- Autocomplete -->
		{#if acItems.length > 0 && editIdx === null}
			<div
				class="border-base-300 bg-base-100 absolute top-full left-0 z-50 mt-0.5 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border shadow-lg"
				role="listbox"
				tabindex="-1"
				onmousedown={(e) => e.preventDefault()}
			>
				{#if acItems[0].kind === 'transform'}
					<div class="border-base-200 border-b px-2 py-1">
						<span class="text-base-content/40 text-[9px] font-semibold tracking-wider uppercase"
							>Transform {lastVar ? varLabel(lastVar) : ''}</span
						>
					</div>
				{/if}
				{#each acItems as item, idx (idx)}
					<button
						type="button"
						role="option"
						aria-selected={idx === acIdx}
						class={[
							'hover:bg-base-200 flex w-full items-center gap-2 px-2 py-1 text-left',
							idx === acIdx && 'bg-base-200'
						]}
						onclick={() => applyAc(item)}
					>
						{#if item.kind === 'var'}
							<span class="overflow-hidden rounded">{@render badge(item.v.source)}</span>
							<code class="min-w-0 flex-1 truncate text-[11px]">{varLabel(item.v)}</code>
							<span class="text-base-content/35 max-w-32 truncate text-[10px]">{item.v.hint}</span>
						{:else if item.kind === 'ref'}
							<span class="overflow-hidden rounded">{@render badge(item.token.source)}</span>
							<code class="min-w-0 flex-1 truncate text-[11px]">{varLabel(item.token)}</code>
							<span class="text-base-content/35 text-[10px]">use reference</span>
						{:else if item.kind === 'transform'}
							<span class="text-base-content/40 w-4 text-center font-mono text-[11px] font-bold"
								>|</span
							>
							<code class="min-w-0 flex-1 truncate text-[11px]">{item.name}</code>
							<span class="text-base-content/35 text-[10px]">{item.hint}</span>
						{:else}
							<span class="text-base-content/40 w-4 text-center font-mono text-[10px]">"</span>
							<code class="min-w-0 flex-1 truncate text-[11px]">{item.text}</code>
							<span class="text-base-content/35 text-[10px]">text</span>
						{/if}
					</button>
				{/each}
				<div class="border-base-200 text-base-content/30 border-t px-2 py-0.5 text-[9px]">
					↑↓ select · Enter/Tab insert · <kbd>|</kbd> transform · <kbd>d:</kbd> <kbd>i:</kbd>
					<kbd>c:</kbd> <kbd>o:</kbd> <kbd>e:</kbd> source · Esc close
				</div>
			</div>
		{/if}

		<!-- Chip editor -->
		{#if editIdx !== null && editing}
			{@const i = editIdx}
			<div
				class="border-base-300 bg-base-100 absolute top-full left-0 z-50 mt-0.5 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border p-2 shadow-lg"
				role="dialog"
				tabindex="-1"
				aria-label="Edit expression part"
				onkeydown={editorKeydown}
			>
				{#if editing.kind === 'var'}
					<div class="flex items-center gap-1" role="radiogroup" aria-label="Variable source">
						{#each VAR_SOURCES as s (s)}
							<button
								type="button"
								role="radio"
								aria-checked={editing.source === s}
								title={SOURCE_LABEL[s]}
								class={[
									'flex size-6 items-center justify-center rounded font-mono text-[10px] font-bold transition',
									editing.source === s
										? 'text-white'
										: 'bg-base-200 text-base-content/50 hover:text-base-content'
								]}
								style:background={editing.source === s ? SOURCE_COLOR[s] : undefined}
								onclick={() => editVar(i, { source: s })}>{SOURCE_LETTER[s]}</button
							>
						{/each}
						<span class="text-base-content/40 ml-1 text-[10px]">{SOURCE_LABEL[editing.source]}</span
						>
					</div>
					<label class="flex flex-col gap-0.5">
						<span class="text-base-content/40 text-[9px] font-semibold tracking-wider uppercase"
							>Variable</span
						>
						<input
							class={['input input-xs font-mono', !pathValid && 'input-error']}
							placeholder={editing.source === 'dot' ? '(whole value)' : 'field.nested[0]'}
							value={editPath}
							oninput={(e) => onEditPath(i, (e.target as HTMLInputElement).value)}
							{@attach (el) => (el as HTMLInputElement).focus()}
						/>
					</label>
					{#if availVars.some((v) => v.source === editing.source && v.path.length > 0)}
						<div class="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
							{#each availVars.filter((v) => v.source === editing.source && v.path.length > 0) as v (refToJq(v.source, v.path))}
								<button
									type="button"
									class="bg-base-200 hover:bg-base-300 rounded px-1 font-mono text-[10px]"
									title={v.hint}
									onclick={() => onEditPath(i, pathToText(v.path))}>{pathToText(v.path)}</button
								>
							{/each}
						</div>
					{/if}
					<label class="flex flex-col gap-0.5">
						<span class="text-base-content/40 text-[9px] font-semibold tracking-wider uppercase"
							>Jq transformer</span
						>
						<input
							class={['input input-xs font-mono', !transformsValid && 'input-error']}
							placeholder="tostring | ascii_downcase"
							value={editTransforms}
							oninput={(e) => onEditTransforms(i, (e.target as HTMLInputElement).value)}
						/>
					</label>
					<div class="flex flex-wrap gap-1">
						{#each TRANSFORMS.slice(0, 10) as t (t.name)}
							<button
								type="button"
								class="bg-base-200 hover:bg-base-300 rounded px-1 font-mono text-[10px]"
								title={t.hint}
								onclick={() => appendTransform(i, t.name)}>{t.name}</button
							>
						{/each}
					</div>
					<code
						class="bg-base-200/60 text-base-content/60 truncate rounded px-1.5 py-0.5 text-[10px]"
						>{[refToJq(editing.source, editing.path), ...editing.transforms].join(' | ')}</code
					>
				{:else if editing.kind === 'literal'}
					<label class="flex flex-col gap-0.5">
						<span class="text-base-content/40 text-[9px] font-semibold tracking-wider uppercase"
							>Text</span
						>
						<input
							class="input input-xs font-mono"
							value={editing.text}
							oninput={(e) =>
								patchToken(i, { kind: 'literal', text: (e.target as HTMLInputElement).value })}
							{@attach (el) => (el as HTMLInputElement).focus()}
						/>
					</label>
				{:else}
					<label class="flex flex-col gap-0.5">
						<span class="text-base-content/40 text-[9px] font-semibold tracking-wider uppercase"
							>jq</span
						>
						<textarea
							class="textarea textarea-xs font-mono"
							rows="3"
							value={editing.expr}
							oninput={(e) =>
								patchToken(i, { kind: 'raw', expr: (e.target as HTMLTextAreaElement).value })}
							{@attach (el) => (el as HTMLTextAreaElement).focus()}></textarea>
					</label>
				{/if}
				<div class="flex items-center justify-between">
					<button
						type="button"
						class="btn btn-ghost btn-xs text-error"
						onclick={() => removeToken(i)}>Remove</button
					>
					<button type="button" class="btn btn-primary btn-xs" onclick={closeEditor}>Done</button>
				</div>
			</div>
		{/if}
	</div>
{/if}
