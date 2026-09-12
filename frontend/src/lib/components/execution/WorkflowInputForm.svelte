<script lang="ts">
	import { untrack } from 'svelte';
	import { Plus, X } from '@lucide/svelte';
	import CodeMirrorEditor from '$lib/components/editor/CodeMirrorEditor.svelte';
	import type { InputField } from '$lib/types';
	import { buildInputSkeleton, coerceInput } from '$lib/zigflow-engine/inputSchema';

	/**
	 * Collects a run's `$input` as the typed fields the workflow actually declares, rather than as
	 * hand-written JSON. A workflow that declares nothing (or an input the form can't express) can
	 * still be run from the JSON tab, which is also the only mode available when there's no schema.
	 */

	interface Props {
		fields: InputField[];
		value: Record<string, unknown>;
		errors?: Record<string, string>;
		/** Reported whenever the JSON tab holds text that isn't a valid object. */
		onjsonerror?: (message: string | null) => void;
	}

	let {
		fields,
		value = $bindable<Record<string, unknown>>({}),
		errors = {},
		onjsonerror
	}: Props = $props();

	// Which tab opens first depends only on whether a schema existed at mount; switching tabs later
	// is the user's call, so this deliberately does not track `fields`.
	let mode = $state<'form' | 'json'>(untrack(() => fields).length > 0 ? 'form' : 'json');
	let jsonDraft = $state('');
	let jsonError = $state<string | null>(null);

	function switchMode(next: 'form' | 'json') {
		if (next === 'json') {
			jsonDraft = JSON.stringify(value, null, 2);
			jsonError = null;
			onjsonerror?.(null);
		} else if (!applyJson(jsonDraft)) {
			return; // stay on the JSON tab so the error is visible next to the text causing it
		}
		mode = next;
	}

	function applyJson(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed) {
			value = {};
			jsonError = null;
			onjsonerror?.(null);
			return true;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return failJson('Not valid JSON.');
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return failJson('Input must be a JSON object.');
		}

		value = coerceInput(fields, parsed as Record<string, unknown>);
		jsonError = null;
		onjsonerror?.(null);
		return true;
	}

	function failJson(message: string): false {
		jsonError = message;
		onjsonerror?.(message);
		return false;
	}

	function handleJsonChange(text: string) {
		jsonDraft = text;
		applyJson(text);
	}

	function setField(name: string, next: unknown) {
		value = { ...value, [name]: next };
	}

	function arrayOf(name: string): unknown[] {
		const raw = value[name];
		return Array.isArray(raw) ? raw : [];
	}

	function setArrayItem(field: InputField, itemIndex: number, raw: string) {
		const next = [...arrayOf(field.name)];
		next[itemIndex] = raw;
		setField(field.name, coerceInput([{ ...field }], { [field.name]: next })[field.name]);
	}

	function addArrayItem(field: InputField) {
		setField(field.name, [...arrayOf(field.name), field.itemsType === 'number' ? 0 : '']);
	}

	function removeArrayItem(field: InputField, itemIndex: number) {
		setField(
			field.name,
			arrayOf(field.name).filter((_, i) => i !== itemIndex)
		);
	}

	function objectText(name: string): string {
		const raw = value[name];
		if (raw === undefined || raw === null) return '';
		return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
	}

	function setObjectField(name: string, text: string) {
		const trimmed = text.trim();
		if (!trimmed) return setField(name, {});
		try {
			setField(name, JSON.parse(trimmed));
		} catch {
			// Keep the raw text so the user doesn't lose it; validateInput reports it as not an object.
			setField(name, text);
		}
	}

	// A field added to the schema after the value object was built would otherwise be absent from
	// the form. `value` is read untracked: this effect writes it, and reading it tracked would
	// re-trigger the effect from its own write.
	$effect(() => {
		const declared = fields;
		const current = untrack(() => value);
		const filled = { ...buildInputSkeleton(declared), ...current };
		if (Object.keys(filled).length !== Object.keys(current).length) value = filled;
	});
</script>

<div class="flex flex-col gap-3">
	{#if fields.length > 0}
		<div role="tablist" class="tabs tabs-box tabs-xs self-start">
			<button
				type="button"
				role="tab"
				class="tab"
				class:tab-active={mode === 'form'}
				onclick={() => switchMode('form')}>Form</button
			>
			<button
				type="button"
				role="tab"
				class="tab"
				class:tab-active={mode === 'json'}
				onclick={() => switchMode('json')}>JSON</button
			>
		</div>
	{/if}

	{#if mode === 'form' && fields.length > 0}
		<div class="flex flex-col gap-3">
			{#each fields.filter((f) => f.name) as field (field.name)}
				<div class="flex flex-col gap-1">
					<label class="text-sm font-medium" for="run-input-{field.name}">
						{field.name}
						{#if field.required}<span class="text-error">*</span>{/if}
						<span class="text-base-content/40 ml-1 text-xs font-normal">
							{field.type}{field.type === 'array' ? ` of ${field.itemsType ?? 'string'}` : ''}
						</span>
					</label>

					{#if field.description}
						<p class="text-base-content/50 text-xs">{field.description}</p>
					{/if}

					{#if field.type === 'boolean'}
						<input
							id="run-input-{field.name}"
							type="checkbox"
							class="toggle toggle-sm"
							checked={value[field.name] === true}
							onchange={(e) => setField(field.name, e.currentTarget.checked)}
						/>
					{:else if field.type === 'number'}
						<input
							id="run-input-{field.name}"
							type="number"
							class="input input-sm w-full"
							class:input-error={!!errors[field.name]}
							placeholder={field.example ?? ''}
							value={String(value[field.name] ?? '')}
							oninput={(e) =>
								setField(
									field.name,
									e.currentTarget.value === '' ? '' : Number(e.currentTarget.value)
								)}
						/>
					{:else if field.type === 'array'}
						<div class="flex flex-col gap-1">
							{#each arrayOf(field.name) as item, itemIndex (itemIndex)}
								<div class="flex items-center gap-1">
									<input
										type={field.itemsType === 'number' ? 'number' : 'text'}
										class="input input-sm w-full"
										value={String(item ?? '')}
										oninput={(e) => setArrayItem(field, itemIndex, e.currentTarget.value)}
									/>
									<button
										type="button"
										class="btn btn-ghost btn-xs"
										aria-label="Remove item {itemIndex + 1}"
										onclick={() => removeArrayItem(field, itemIndex)}
									>
										<X size={12} />
									</button>
								</div>
							{/each}
							<button
								type="button"
								class="btn btn-ghost btn-xs self-start gap-1"
								onclick={() => addArrayItem(field)}
							>
								<Plus size={12} /> Add item
							</button>
						</div>
					{:else if field.type === 'object'}
						<div class="border-base-300 overflow-hidden rounded border">
							<CodeMirrorEditor
								value={objectText(field.name)}
								language="json"
								onchange={(text) => setObjectField(field.name, text)}
							/>
						</div>
					{:else}
						<input
							id="run-input-{field.name}"
							type="text"
							class="input input-sm w-full"
							class:input-error={!!errors[field.name]}
							placeholder={field.example ?? ''}
							value={String(value[field.name] ?? '')}
							oninput={(e) => setField(field.name, e.currentTarget.value)}
						/>
					{/if}

					{#if errors[field.name]}
						<p class="text-error text-xs">{errors[field.name]}</p>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="flex flex-col gap-1">
			{#if fields.length === 0}
				<p class="text-base-content/50 text-xs">
					This workflow declares no <code>$input</code> schema. Provide raw JSON here, or declare
					fields on the Start node to get a form.
				</p>
			{/if}
			<div class="border-base-300 overflow-hidden rounded border">
				<CodeMirrorEditor
					value={jsonDraft}
					language="json"
					onchange={handleJsonChange}
				/>
			</div>
			{#if jsonError}
				<p class="text-error text-xs">{jsonError}</p>
			{/if}
		</div>
	{/if}
</div>
