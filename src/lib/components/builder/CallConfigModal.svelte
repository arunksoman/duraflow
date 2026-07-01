<script lang="ts">
	import { untrack } from 'svelte';
	import type { Node } from '@xyflow/svelte';
	import { Plus, Trash2, X } from '@lucide/svelte';
	import { NODE_META } from './builderConfig';

	type KVPair = { key: string; value: string };

	interface Props {
		node: Node;
		onclose: () => void;
		onupdate: (id: string, patch: Record<string, unknown>) => void;
	}

	let { node, onclose, onupdate }: Props = $props();

	const meta = NODE_META['call'];
	const HeaderIcon = meta.icon;

	let label = $state<string>(untrack(() => (node?.data?.label as string) ?? 'HTTP Call'));
	let method = $state<string>(untrack(() => (node?.data?.method as string) ?? 'get'));
	let endpoint = $state<string>(untrack(() => (node?.data?.endpoint as string) ?? ''));
	let headers = $state<KVPair[]>(
		untrack(() =>
			Array.isArray(node?.data?.headers)
				? (node.data.headers as KVPair[]).map((h) => ({ ...h }))
				: []
		)
	);
	let query = $state<KVPair[]>(
		untrack(() =>
			Array.isArray(node?.data?.query)
				? (node.data.query as KVPair[]).map((q) => ({ ...q }))
				: []
		)
	);
	let body = $state<string>(untrack(() => (node?.data?.body as string) ?? ''));
	let output = $state<string>(untrack(() => (node?.data?.output as string) ?? 'content'));
	let redirect = $state<boolean>(untrack(() => Boolean(node?.data?.redirect)));

	function patch(key: string, value: unknown) {
		if (node) onupdate(node.id, { [key]: value });
	}

	function saveHeaders() {
		patch('headers', headers.map((h) => ({ ...h })));
	}

	function saveQuery() {
		patch('query', query.map((q) => ({ ...q })));
	}

	function addHeader() {
		headers = [...headers, { key: '', value: '' }];
		saveHeaders();
	}

	function removeHeader(i: number) {
		headers = headers.filter((_, idx) => idx !== i);
		saveHeaders();
	}

	function updateHeader(i: number, f: keyof KVPair, val: string) {
		headers = headers.map((h, idx) => (idx === i ? { ...h, [f]: val } : h));
		saveHeaders();
	}

	function addQuery() {
		query = [...query, { key: '', value: '' }];
		saveQuery();
	}

	function removeQuery(i: number) {
		query = query.filter((_, idx) => idx !== i);
		saveQuery();
	}

	function updateQuery(i: number, f: keyof KVPair, val: string) {
		query = query.map((q, idx) => (idx === i ? { ...q, [f]: val } : q));
		saveQuery();
	}
</script>

<div class="modal modal-open z-50">
	<div class="modal-box max-w-lg">
		<!-- Header -->
		<div class="mb-4 flex items-center gap-3">
			<div
				class="flex size-9 shrink-0 items-center justify-center rounded-lg"
				style:background="{meta.color}22"
				style:color={meta.color}
			>
				<HeaderIcon size={16} />
			</div>
			<div class="min-w-0 flex-1">
				<h3 class="text-sm font-semibold">REST Config</h3>
				<p class="text-base-content/40 truncate text-xs">REST API · call: http</p>
			</div>
			<button class="btn btn-ghost btn-sm btn-circle" onclick={onclose} aria-label="Close">
				<X size={15} />
			</button>
		</div>

		<div class="divider my-0 mb-3"></div>

		<div class="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
			<!-- Label -->
			<div class="flex flex-col gap-1">
				<label class="text-base-content/60 text-xs font-medium" for="cc-label">Label</label>
				<input
					id="cc-label"
					class="input input-sm w-full"
					value={label}
					oninput={(e) => {
						label = (e.target as HTMLInputElement).value;
						patch('label', label);
					}}
				/>
			</div>

			<!-- Method + Endpoint -->
			<div class="flex flex-col gap-1">
				<span class="text-base-content/60 text-xs font-medium">Endpoint</span>
				<div class="flex gap-2">
					<select
						class="select select-sm w-28 shrink-0 font-mono font-semibold"
						value={method}
						onchange={(e) => {
							method = (e.target as HTMLSelectElement).value;
							patch('method', method);
						}}
					>
						{#each ['get', 'post', 'put', 'patch', 'delete'] as m (m)}
							<option value={m}>{m.toUpperCase()}</option>
						{/each}
					</select>
					<input
						class="input input-sm min-w-0 flex-1 font-mono text-xs"
						placeholder="https://api.example.com/resource"
						value={endpoint}
						oninput={(e) => {
							endpoint = (e.target as HTMLInputElement).value;
							patch('endpoint', endpoint);
						}}
					/>
				</div>
			</div>

			<!-- Headers -->
			<div class="flex flex-col gap-2">
				<div class="flex items-center justify-between">
					<span class="text-base-content/60 text-xs font-medium">Headers</span>
					<button class="btn btn-ghost btn-xs gap-1" onclick={addHeader}>
						<Plus size={10} />
						Add
					</button>
				</div>
				{#if headers.length === 0}
					<p class="text-base-content/30 py-1 text-center text-xs">No headers — click Add.</p>
				{:else}
					{#each headers as h, i (i)}
						<div class="flex items-center gap-1">
							<input
								class="input input-xs w-36 shrink-0 font-mono"
								placeholder="Header-Name"
								value={h.key}
								oninput={(e) => updateHeader(i, 'key', (e.target as HTMLInputElement).value)}
							/>
							<span class="text-base-content/30 shrink-0 text-xs">:</span>
							<input
								class="input input-xs min-w-0 flex-1 font-mono"
								placeholder={'value or ${ $secrets.token }'}
								value={h.value}
								oninput={(e) => updateHeader(i, 'value', (e.target as HTMLInputElement).value)}
							/>
							<button
								class="btn btn-ghost btn-xs btn-circle text-error shrink-0"
								onclick={() => removeHeader(i)}
								aria-label="Remove header"
							>
								<Trash2 size={10} />
							</button>
						</div>
					{/each}
				{/if}
			</div>

			<!-- Query Parameters -->
			<div class="flex flex-col gap-2">
				<div class="flex items-center justify-between">
					<span class="text-base-content/60 text-xs font-medium">Query Parameters</span>
					<button class="btn btn-ghost btn-xs gap-1" onclick={addQuery}>
						<Plus size={10} />
						Add
					</button>
				</div>
				{#if query.length === 0}
					<p class="text-base-content/30 py-1 text-center text-xs">No query params — click Add.</p>
				{:else}
					{#each query as q, i (i)}
						<div class="flex items-center gap-1">
							<input
								class="input input-xs w-36 shrink-0 font-mono"
								placeholder="param"
								value={q.key}
								oninput={(e) => updateQuery(i, 'key', (e.target as HTMLInputElement).value)}
							/>
							<span class="text-base-content/30 shrink-0 text-xs">=</span>
							<input
								class="input input-xs min-w-0 flex-1 font-mono"
								placeholder={'value or ${ expression }'}
								value={q.value}
								oninput={(e) => updateQuery(i, 'value', (e.target as HTMLInputElement).value)}
							/>
							<button
								class="btn btn-ghost btn-xs btn-circle text-error shrink-0"
								onclick={() => removeQuery(i)}
								aria-label="Remove query param"
							>
								<Trash2 size={10} />
							</button>
						</div>
					{/each}
				{/if}
			</div>

			<!-- Body -->
			<div class="flex flex-col gap-1">
				<label class="text-base-content/60 text-xs font-medium" for="cc-body">
					Body
					<span class="text-base-content/30 font-normal">— JSON or expression; omit for GET</span>
				</label>
				<textarea
					id="cc-body"
					class="textarea textarea-sm w-full font-mono text-xs leading-relaxed"
					rows={5}
					placeholder={'{ "key": "value" }'}
					value={body}
					oninput={(e) => {
						body = (e.target as HTMLTextAreaElement).value;
						patch('body', body);
					}}
				></textarea>
			</div>

			<!-- Response Options -->
			<div class="border-base-300 flex flex-col gap-3 rounded-lg border p-3">
				<span class="text-base-content/60 text-xs font-medium">Response Options</span>

				<div class="flex items-center gap-3">
					<span class="text-base-content/50 w-20 shrink-0 text-xs">Output</span>
					<select
						class="select select-xs flex-1"
						value={output}
						onchange={(e) => {
							output = (e.target as HTMLSelectElement).value;
							patch('output', output);
						}}
					>
						<option value="content">content — deserialized body (default)</option>
						<option value="raw">raw — base-64 encoded body</option>
						<option value="response">response — full HTTP response object</option>
					</select>
				</div>

				<div class="flex items-center gap-3">
					<span class="text-base-content/50 w-20 shrink-0 text-xs">Redirects</span>
					<label class="flex cursor-pointer items-center gap-2">
						<input
							type="checkbox"
							class="checkbox checkbox-xs"
							checked={redirect}
							onchange={(e) => {
								redirect = (e.target as HTMLInputElement).checked;
								patch('redirect', redirect);
							}}
						/>
						<span class="text-xs">Follow 3xx redirects</span>
					</label>
				</div>

				<p class="text-base-content/25 text-xs">
					4xx → non-retryable error · 5xx → retryable · 408 / 429 → retryable
				</p>
			</div>
		</div>

		<div class="modal-action mt-4">
			<button class="btn btn-sm btn-primary" onclick={onclose}>Done</button>
		</div>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button onclick={onclose}>close</button>
	</form>
</div>
