<script lang="ts">
	import { untrack } from 'svelte';
	import type { Node, Edge } from '@xyflow/svelte';
	import { Plus, Trash2, X } from '@lucide/svelte';
	import type { WorkflowMeta } from '$lib/types';
	import { NODE_META } from './builderConfig';
	import type { VarEntry, CaseEntry, EventEntry } from './builderConfig';
	import type { WorkflowNodeType } from '$lib/types';
	import ExpressionInput, { type AvailVar } from './ExpressionInput.svelte';
	import ConditionBuilder from './ConditionBuilder.svelte';

	interface Props {
		node: Node;
		nodes: Node[];
		edges: Edge[];
		workflowMeta: WorkflowMeta;
		width?: number;
		onclose: () => void;
		onupdate: (id: string, patch: Record<string, unknown>) => void;
	}

	let { node, nodes, edges, workflowMeta, width = 340, onclose, onupdate }: Props = $props();

	const nodeType = $derived<WorkflowNodeType>(
		node && (node.type ?? 'task') in NODE_META ? (node.type as WorkflowNodeType) : 'task'
	);
	const meta = $derived(NODE_META[nodeType]);
	const Icon = $derived(meta.icon);

	// Panel is destroyed/recreated by {#if configNode} in parent — untrack is safe
	let localVars = $state<VarEntry[]>(
		untrack(() =>
			Array.isArray(node?.data?.variables)
				? (node.data.variables as VarEntry[]).map((v) => ({ ...v }))
				: []
		)
	);
	let localCases = $state<CaseEntry[]>(
		untrack(() =>
			Array.isArray(node?.data?.cases)
				? (node.data.cases as CaseEntry[]).map((c) => ({ ...c }))
				: [{ name: 'default', condition: '', then: 'end' }]
		)
	);
	let localHeaders = $state<VarEntry[]>(
		untrack(() =>
			Array.isArray(node?.data?.headers)
				? (node.data.headers as VarEntry[]).map((h) => ({ ...h }))
				: []
		)
	);
	let localQuery = $state<VarEntry[]>(
		untrack(() =>
			Array.isArray(node?.data?.query)
				? (node.data.query as VarEntry[]).map((q) => ({ ...q }))
				: []
		)
	);
	let localEvents = $state<EventEntry[]>(
		untrack(() =>
			Array.isArray(node?.data?.events)
				? (node.data.events as EventEntry[]).map((e) => ({ ...e }))
				: [{ id: '', type: 'signal' as const }]
		)
	);
	let runType = $state<string>(untrack(() => (node?.data?.runType as string) ?? 'script'));
	let waitMode = $state<string>(untrack(() => (node?.data?.waitMode as string) ?? 'duration'));

	// ── helpers ──────────────────────────────────────────────────────

	function f(key: string): string {
		return (node?.data[key] as string) ?? '';
	}
	function num(key: string, fallback: number): number {
		const v = node?.data[key];
		return typeof v === 'number' ? v : fallback;
	}
	function bool(key: string, fallback = false): boolean {
		const v = node?.data[key];
		return typeof v === 'boolean' ? v : fallback;
	}
	function patch(key: string, value: unknown) {
		onupdate(node.id, { [key]: value });
	}
	function patchMany(obj: Record<string, unknown>) {
		onupdate(node.id, obj);
	}

	// ── array editors ─────────────────────────────────────────────────

	function saveVars() { patch('variables', localVars.map((v) => ({ ...v }))); }
	function addVar() { localVars = [...localVars, { key: '', value: '' }]; saveVars(); }
	function removeVar(i: number) { localVars = localVars.filter((_, j) => j !== i); saveVars(); }
	function updateVar(i: number, k: keyof VarEntry, v: string) {
		localVars = localVars.map((x, j) => j === i ? { ...x, [k]: v } : x);
		saveVars();
	}

	function saveCases() { patch('cases', localCases.map((c) => ({ ...c }))); }
	function addCase() {
		localCases = [...localCases, { name: `case${localCases.length + 1}`, condition: '', then: 'continue' }];
		saveCases();
	}
	function removeCase(i: number) { localCases = localCases.filter((_, j) => j !== i); saveCases(); }
	function updateCase(i: number, k: keyof CaseEntry, v: string) {
		localCases = localCases.map((c, j) => j === i ? { ...c, [k]: v } : c);
		saveCases();
	}

	function saveHeaders() { patch('headers', localHeaders.map((h) => ({ ...h }))); }
	function addHeader() { localHeaders = [...localHeaders, { key: '', value: '' }]; saveHeaders(); }
	function removeHeader(i: number) { localHeaders = localHeaders.filter((_, j) => j !== i); saveHeaders(); }
	function updateHeader(i: number, k: keyof VarEntry, v: string) {
		localHeaders = localHeaders.map((h, j) => j === i ? { ...h, [k]: v } : h);
		saveHeaders();
	}

	function saveQuery() { patch('query', localQuery.map((q) => ({ ...q }))); }
	function addQuery() { localQuery = [...localQuery, { key: '', value: '' }]; saveQuery(); }
	function removeQuery(i: number) { localQuery = localQuery.filter((_, j) => j !== i); saveQuery(); }
	function updateQuery(i: number, k: keyof VarEntry, v: string) {
		localQuery = localQuery.map((q, j) => j === i ? { ...q, [k]: v } : q);
		saveQuery();
	}

	function saveEvents() { patch('events', localEvents.map((e) => ({ ...e }))); }
	function addEvent() { localEvents = [...localEvents, { id: '', type: 'signal' as const }]; saveEvents(); }
	function removeEvent(i: number) { localEvents = localEvents.filter((_, j) => j !== i); saveEvents(); }
	function updateEvent(i: number, k: keyof EventEntry, v: string) {
		localEvents = localEvents.map((e, j) => j === i ? { ...e, [k]: v } : e) as EventEntry[];
		saveEvents();
	}

	// ── task slug (DSL id derived from label) ─────────────────────────

	const taskSlug = $derived.by(() => {
		const lbl = (node?.data?.label as string) ?? nodeType;
		return lbl.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
	});

	// ── available variables at this node ─────────────────────────────

	const availableVars = $derived.by<AvailVar[]>(() => {
		const vars: AvailVar[] = [];

		// $input fields
		for (const field of workflowMeta.inputSchema ?? []) {
			vars.push({
				expr: '${ $input.' + field.name + ' }',
				hint: field.example ? 'e.g. ' + field.example : (field.type ?? 'string'),
				category: 'input',
				source: '$input',
				field: field.name,
				rawRef: '$input.' + field.name
			});
		}
		if ((workflowMeta.inputSchema ?? []).length === 0) {
			vars.push({ expr: '${ $input }', hint: 'full trigger payload', category: 'input', source: '$input', field: '', rawRef: '$input' });
		}

		// $env vars
		for (const e of workflowMeta.envVars ?? []) {
			vars.push({
				expr: '${ $env.' + e.name + ' }',
				hint: e.example ? 'e.g. ' + e.example : (e.description ?? ''),
				category: 'env',
				source: '$env',
				field: e.name,
				rawRef: '$env.' + e.name
			});
		}

		// $output (always)
		vars.push({ expr: '${ . }', hint: 'previous task output (shorthand)', category: 'output', source: '.', field: '', rawRef: '.' });
		vars.push({ expr: '${ $output }', hint: 'previous task full output', category: 'output', source: '$output', field: '', rawRef: '$output' });

		// $data keys from upstream Set nodes (and start node vars)
		const ancestors: string[] = [];
		const queue = [node.id];
		while (queue.length > 0) {
			const curr = queue.shift()!;
			for (const edge of edges) {
				if (edge.target === curr && !ancestors.includes(edge.source)) {
					ancestors.push(edge.source);
					queue.push(edge.source);
				}
			}
		}

		const startNode = nodes.find((n) => n.type === 'start');
		if (startNode) {
			for (const v of (startNode.data?.variables as VarEntry[]) ?? []) {
				if (v.key) vars.push({ expr: '${ $data.' + v.key + ' }', hint: 'from Start init', category: 'data', source: '$data', field: v.key, rawRef: '$data.' + v.key });
			}
		}

		for (const n of nodes) {
			if (ancestors.includes(n.id) && n.type === 'set') {
				for (const v of (n.data?.variables as VarEntry[]) ?? []) {
					if (v.key) vars.push({ expr: '${ $data.' + v.key + ' }', hint: 'from Set: ' + (n.data?.label ?? 'Set'), category: 'data', source: '$data', field: v.key, rawRef: '$data.' + v.key });
				}
			}
		}

		// $context hint (when upstream nodes have export.as)
		const hasExports = ancestors.some((aid) => {
			const an = nodes.find((n) => n.id === aid);
			return an && (an.data?.exportAs as string);
		});
		if (hasExports) {
			vars.push({ expr: '${ $context }', hint: 'accumulated via export.as', category: 'context', source: '$context', field: '', rawRef: '$context' });
		}

		return vars;
	});

	// ── switch then options ───────────────────────────────────────────

	const thenOptions = $derived.by(() => {
		const directives = [
			{ value: 'continue', label: 'continue — proceed to next task' },
			{ value: 'end', label: 'end — terminate workflow' },
			{ value: 'exit', label: 'exit — leave current scope' }
		];
		const nodeOptions = nodes
			.filter((n) => n.id !== node.id && n.type !== 'start')
			.map((n) => ({
				value: n.id,
				label: `${n.data?.label ?? n.type} (${n.type})`
			}));
		return [...directives, ...nodeOptions];
	});

	const noDataFlow = ['start', 'end'] as const;
	const hasDataFlow = $derived(!noDataFlow.includes(nodeType as (typeof noDataFlow)[number]));
</script>

<!-- Right panel — resizable, scrollable, no overlay -->
<aside class="bg-base-100 border-base-300 flex shrink-0 flex-col border-l" style="width: {width}px; min-width: {width}px">
	<!-- Header -->
	<div class="border-base-200 flex shrink-0 items-center gap-2.5 border-b px-3 py-2.5">
		<div
			class="flex size-7 shrink-0 items-center justify-center rounded-md"
			style:background="{meta.color}22"
			style:color={meta.color}
		>
			<Icon size={14} />
		</div>
		<div class="min-w-0 flex-1">
			<p class="text-base-content text-xs font-semibold leading-tight">{f('label') || meta.label}</p>
			<p class="text-base-content/40 font-mono text-[10px]">{taskSlug}</p>
		</div>
		<button class="btn btn-ghost btn-xs btn-circle" onclick={onclose} aria-label="Close panel">
			<X size={13} />
		</button>
	</div>

	<!-- Scrollable content -->
	<div class="flex flex-1 flex-col gap-0 overflow-y-auto">

		<!-- ── CONFIG SECTION ─────────────────────────────────────────── -->
		<div class="flex flex-col gap-3 p-3">

			<!-- Label (all except end) -->
			{#if nodeType !== 'end'}
				<div class="flex flex-col gap-1">
					<label class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider" for="np-label">Label</label>
					<input
						id="np-label"
						class="input input-sm w-full"
						value={f('label')}
						oninput={(e) => patch('label', (e.target as HTMLInputElement).value)}
					/>
				</div>
			{/if}

			<!-- ── REST (call: http) ─────────────────────────────────── -->
			{#if nodeType === 'call'}
				<!-- Endpoint -->
				<div class="flex flex-col gap-0.5">
					<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">Endpoint</span>
					<div class="flex items-center gap-1">
						<select
							class="select select-xs w-20 shrink-0 font-mono font-bold"
							value={f('method') || 'get'}
							onchange={(e) => patch('method', (e.target as HTMLSelectElement).value)}
						>
							{#each ['get','post','put','patch','delete'] as m (m)}
								<option value={m}>{m.toUpperCase()}</option>
							{/each}
						</select>
						<div class="min-w-0 flex-1">
							<ExpressionInput
								value={f('endpoint')}
								placeholder={'$env.API_BASE + "/path"'}
								availVars={availableVars}
								onchange={(v) => patch('endpoint', v)}
							/>
						</div>
					</div>
				</div>

				<!-- Headers -->
				<div class="flex flex-col gap-1.5">
					<div class="flex items-center justify-between">
						<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">Headers</span>
						<button class="btn btn-ghost btn-xs gap-1" onclick={addHeader}><Plus size={9} />Add</button>
					</div>
					{#each localHeaders as h, i (i)}
						<div class="flex items-start gap-1.5">
							<input class="input input-xs w-32 shrink-0 font-mono" placeholder="Header-Name" value={h.key}
								oninput={(e) => updateHeader(i, 'key', (e.target as HTMLInputElement).value)} />
							<div class="min-w-0 flex-1">
								<ExpressionInput
									value={h.value}
									placeholder="value or expression"
									availVars={availableVars}
									onchange={(val) => updateHeader(i, 'value', val)}
								/>
							</div>
							<button class="btn btn-ghost btn-xs btn-circle text-error mt-0.5 shrink-0" onclick={() => removeHeader(i)} aria-label="Remove">
								<Trash2 size={9} />
							</button>
						</div>
					{/each}
				</div>

				<!-- Query params -->
				<div class="flex flex-col gap-1.5">
					<div class="flex items-center justify-between">
						<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">Query Params</span>
						<button class="btn btn-ghost btn-xs gap-1" onclick={addQuery}><Plus size={9} />Add</button>
					</div>
					{#each localQuery as q, i (i)}
						<div class="flex items-start gap-1.5">
							<input class="input input-xs w-32 shrink-0 font-mono" placeholder="param" value={q.key}
								oninput={(e) => updateQuery(i, 'key', (e.target as HTMLInputElement).value)} />
							<div class="min-w-0 flex-1">
								<ExpressionInput
									value={q.value}
									placeholder="value or expression"
									availVars={availableVars}
									onchange={(val) => updateQuery(i, 'value', val)}
								/>
							</div>
							<button class="btn btn-ghost btn-xs btn-circle text-error mt-0.5 shrink-0" onclick={() => removeQuery(i)} aria-label="Remove">
								<Trash2 size={9} />
							</button>
						</div>
					{/each}
				</div>

				<!-- Body -->
				<div class="flex flex-col gap-1">
					<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">
						Body <span class="text-base-content/30 normal-case font-normal">— JSON or expression</span>
					</span>
					<ExpressionInput
						value={f('body')}
						placeholder={'{ "key": "value" } or ${ . }'}
						multiline={true}
						rows={4}
						availVars={availableVars}
						onchange={(v) => patch('body', v)}
					/>
				</div>

				<!-- Response -->
				<div class="flex flex-col gap-2">
					<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">Response</span>
					<div class="flex items-center gap-2">
						<span class="text-base-content/40 w-16 shrink-0 text-xs">Output</span>
						<select class="select select-xs flex-1" value={f('output') || 'content'}
							onchange={(e) => patch('output', (e.target as HTMLSelectElement).value)}>
							<option value="content">content — deserialized body</option>
							<option value="raw">raw — base64 encoded</option>
							<option value="response">response — full HTTP response</option>
						</select>
					</div>
					<label class="flex cursor-pointer items-center gap-2 text-xs">
						<input type="checkbox" class="checkbox checkbox-xs" checked={bool('redirect')}
							onchange={(e) => patch('redirect', (e.target as HTMLInputElement).checked)} />
						Follow 3xx redirects
					</label>
					<p class="text-base-content/25 text-[10px]">4xx → non-retryable · 5xx → retryable · 408/429 → retryable</p>
				</div>
			{/if}

			<!-- ── TASK (simple HTTP) ─────────────────────────────────── -->
			{#if nodeType === 'task'}
				<div class="flex items-center gap-1">
					<select class="select select-xs w-20 shrink-0 font-mono font-bold" value={f('method') || 'get'}
						onchange={(e) => patch('method', (e.target as HTMLSelectElement).value)}>
						{#each ['get','post','put','patch','delete'] as m (m)}
							<option value={m}>{m.toUpperCase()}</option>
						{/each}
					</select>
					<div class="min-w-0 flex-1">
						<ExpressionInput
							value={f('endpoint')}
							placeholder={'https://api.example.com/endpoint'}
							availVars={availableVars}
							onchange={(v) => patch('endpoint', v)}
						/>
					</div>
				</div>
				<div class="flex flex-col gap-1">
					<label class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider" for="np-timeout">Timeout</label>
					<input id="np-timeout" class="input input-xs w-full" placeholder="30s"
						value={f('timeout')}
						oninput={(e) => patch('timeout', (e.target as HTMLInputElement).value)} />
				</div>
			{/if}

			<!-- ── IF ────────────────────────────────────────────────── -->
			{#if nodeType === 'if'}
				<div class="flex flex-col gap-2">
					<div class="flex flex-col gap-0.5">
						<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">Condition</span>
						<ConditionBuilder
							value={f('condition')}
							availVars={availableVars}
							onchange={(v) => patch('condition', v)}
						/>
						<p class="text-base-content/30 text-[9px]">Task executes only when this jq expression is truthy. Leave blank to always run.</p>
					</div>
					<div class="flex flex-col gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">Variables → $data</span>
							<button class="btn btn-ghost btn-xs gap-1" onclick={addVar}><Plus size={9} />Add</button>
						</div>
						{#if localVars.length === 0}
							<p class="text-base-content/30 py-2 text-center text-xs">No variables — click Add.</p>
						{:else}
							{#each localVars as v, i (i)}
								<div class="flex items-start gap-1.5">
									<input class="input input-xs w-32 shrink-0 font-mono" placeholder="key" value={v.key}
										oninput={(e) => updateVar(i, 'key', (e.target as HTMLInputElement).value)} />
									<div class="min-w-0 flex-1">
										<ExpressionInput
											value={v.value}
											placeholder={'${ . } or literal'}
											availVars={availableVars}
											onchange={(val) => updateVar(i, 'value', val)}
										/>
									</div>
									<button class="btn btn-ghost btn-xs btn-circle text-error mt-0.5 shrink-0" onclick={() => removeVar(i)} aria-label="Remove"><Trash2 size={9} /></button>
								</div>
							{/each}
						{/if}
					</div>
				</div>
			{/if}

			<!-- ── SET ───────────────────────────────────────────────── -->
			{#if nodeType === 'set' || nodeType === 'start'}
				<div class="flex flex-col gap-1.5">
					<div class="flex items-center justify-between">
						<div>
							<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">
								{nodeType === 'start' ? 'Init Variables' : 'Variables → $data'}
							</span>
							{#if nodeType === 'set'}
								<p class="text-base-content/30 text-[9px]">Readable as ${'${ $data.<key> }'} downstream</p>
							{/if}
						</div>
						<button class="btn btn-ghost btn-xs gap-1" onclick={addVar}><Plus size={9} />Add</button>
					</div>
					{#if localVars.length === 0}
						<p class="text-base-content/30 py-2 text-center text-xs">No variables — click Add.</p>
					{:else}
						{#each localVars as v, i (i)}
							<div class="flex items-start gap-1.5">
								<input class="input input-xs w-32 shrink-0 font-mono" placeholder="key" value={v.key}
									oninput={(e) => updateVar(i, 'key', (e.target as HTMLInputElement).value)} />
								<div class="min-w-0 flex-1">
									<ExpressionInput
										value={v.value}
										placeholder={'${ . } or literal'}
										availVars={availableVars}
										onchange={(val) => updateVar(i, 'value', val)}
									/>
								</div>
								<button class="btn btn-ghost btn-xs btn-circle text-error mt-0.5 shrink-0" onclick={() => removeVar(i)} aria-label="Remove"><Trash2 size={9} /></button>
							</div>
						{/each}
					{/if}
					{#if nodeType === 'set'}
						<p class="text-base-content/25 text-[9px]">Tip: Use ${'${ uuid }'} or ${'${ timestamp }'} here — not in other task fields.</p>
					{/if}
				</div>
			{/if}

			<!-- ── SWITCH ─────────────────────────────────────────────── -->
			{#if nodeType === 'switch'}
				<div class="flex flex-col gap-2">
					<div class="flex items-center justify-between">
						<span class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">Cases</span>
						<button class="btn btn-ghost btn-xs gap-1" onclick={addCase}><Plus size={9} />Add case</button>
					</div>
					{#each localCases as c, i (i)}
						<div class="border-base-300 flex flex-col gap-1.5 rounded-lg border p-2">
							<div class="flex items-center gap-1.5">
								<span class="text-base-content/40 w-10 shrink-0 text-[10px]">name</span>
								<input class="input input-xs min-w-0 flex-1 font-mono" placeholder="success" value={c.name}
									oninput={(e) => updateCase(i, 'name', (e.target as HTMLInputElement).value)} />
								<button class="btn btn-ghost btn-xs btn-circle text-error shrink-0" onclick={() => removeCase(i)} aria-label="Remove"><Trash2 size={9} /></button>
							</div>
							<div class="flex flex-col gap-0.5">
								<span class="text-base-content/40 text-[10px]">when</span>
								<ConditionBuilder
									value={c.condition}
									placeholder={'${ .status == "ok" }  (blank = default)'}
									availVars={availableVars}
									onchange={(val) => updateCase(i, 'condition', val)}
								/>
							</div>
							<div class="flex items-center gap-1.5">
								<span class="text-base-content/40 w-10 shrink-0 text-[10px]">then</span>
								<select class="select select-xs min-w-0 flex-1 text-xs" value={c.then}
									onchange={(e) => updateCase(i, 'then', (e.target as HTMLSelectElement).value)}>
									{#each thenOptions as opt (opt.value)}
										<option value={opt.value}>{opt.label}</option>
									{/each}
								</select>
							</div>
						</div>
					{/each}
					<p class="text-base-content/30 text-[9px]">Cases evaluated top-to-bottom. First match wins. Blank "when" = default.</p>
				</div>
			{/if}

			<!-- ── FOR ────────────────────────────────────────────────── -->
			{#if nodeType === 'for'}
				<div class="grid grid-cols-2 gap-2">
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-each">each (item var)</label>
						<input id="np-each" class="input input-xs font-mono" placeholder="item" value={f('each') || 'item'}
							oninput={(e) => patch('each', (e.target as HTMLInputElement).value)} />
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-at">at (index var)</label>
						<input id="np-at" class="input input-xs font-mono" placeholder="index" value={f('at') || 'index'}
							oninput={(e) => patch('at', (e.target as HTMLInputElement).value)} />
					</div>
				</div>
				<div class="flex flex-col gap-1">
					<span class="text-base-content/50 text-[10px] font-semibold uppercase">in (collection expr)</span>
					<ExpressionInput
						value={f('in') || '${ $input.items }'}
						placeholder={'${ $input.items }'}
						availVars={availableVars}
						onchange={(v) => patch('in', v)}
					/>
					<p class="text-base-content/30 text-[9px]">Read via ${'${ $data.item }'} and ${'${ $data.index }'} inside the loop</p>
				</div>
				<div class="flex flex-col gap-1">
					<span class="text-base-content/50 text-[10px] font-semibold uppercase">while (continue if true)</span>
					<ConditionBuilder
						value={f('while')}
						placeholder={'${ $data.index < 10 }  (optional)'}
						availVars={availableVars}
						onchange={(v) => patch('while', v)}
					/>
				</div>
			{/if}

			<!-- ── FORK ───────────────────────────────────────────────── -->
			{#if nodeType === 'fork'}
				<label class="flex cursor-pointer items-center gap-2 text-xs">
					<input type="checkbox" class="checkbox checkbox-xs" checked={bool('compete')}
						onchange={(e) => patch('compete', (e.target as HTMLInputElement).checked)} />
					<span>Compete mode — return only the fastest branch</span>
				</label>
				<p class="text-base-content/30 text-[9px]">Connect edges from this node to each branch's first task. The branches are derived from outgoing edges.</p>
			{/if}

			<!-- ── TRY ────────────────────────────────────────────────── -->
			{#if nodeType === 'try'}
				<div class="flex flex-col gap-1">
					<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-catchas">catch error as</label>
					<input id="np-catchas" class="input input-xs font-mono w-full" placeholder="error"
						value={f('catchAs') || 'error'}
						oninput={(e) => patch('catchAs', (e.target as HTMLInputElement).value)} />
					<p class="text-base-content/30 text-[9px]">Error object available as ${'${ $data.<catchAs> }'} in the catch block</p>
				</div>
			{/if}

			<!-- ── WAIT ───────────────────────────────────────────────── -->
			{#if nodeType === 'wait'}
				<div class="flex gap-2">
					{#each ['duration', 'until'] as mode (mode)}
						<label class="flex cursor-pointer items-center gap-1.5 text-xs">
							<input type="radio" class="radio radio-xs" name="wait-mode" value={mode}
								checked={waitMode === mode}
								onchange={() => { waitMode = mode; patch('waitMode', mode); }} />
							{mode === 'duration' ? 'Duration' : 'Until timestamp'}
						</label>
					{/each}
				</div>

				{#if waitMode === 'duration'}
					<div class="grid grid-cols-4 gap-2">
						{#each [['days','d'],['hours','h'],['minutes','m'],['seconds','s']] as [key, suffix] (key)}
							<div class="flex flex-col gap-0.5">
								<label class="text-base-content/40 text-[10px]" for="np-{key}">{key}</label>
								<input id="np-{key}" type="number" min="0" class="input input-xs font-mono"
									value={num(key, key === 'seconds' ? 30 : 0)}
									oninput={(e) => patch(key, Number((e.target as HTMLInputElement).value))} />
							</div>
						{/each}
					</div>
					<p class="text-base-content/30 text-[9px]">Values support expressions e.g. ${'${ $data.delaySeconds }'}</p>
				{:else}
					<div class="flex flex-col gap-1">
						<span class="text-base-content/50 text-[10px] font-semibold uppercase">RFC 3339 timestamp</span>
						<ExpressionInput
							value={f('until')}
							placeholder={'2026-12-31T23:59:59Z or ${ $data.deadline }'}
							availVars={availableVars}
							onchange={(v) => patch('until', v)}
						/>
						<p class="text-base-content/30 text-[9px]">Past timestamps are a no-op — execution continues immediately</p>
					</div>
				{/if}
			{/if}

			<!-- ── LISTEN ─────────────────────────────────────────────── -->
			{#if nodeType === 'listen'}
				<div class="flex flex-col gap-1">
					<span class="text-base-content/50 text-[10px] font-semibold uppercase">Strategy</span>
					<div class="flex gap-3">
						{#each ['all','any','one'] as s (s)}
							<label class="flex cursor-pointer items-center gap-1.5 text-xs">
								<input type="radio" class="radio radio-xs" name="listen-strat" value={s}
									checked={(f('strategy') || 'one') === s}
									onchange={() => patch('strategy', s)} />
								{s}
							</label>
						{/each}
					</div>
				</div>
				<div class="flex flex-col gap-1.5">
					<div class="flex items-center justify-between">
						<span class="text-base-content/50 text-[10px] font-semibold uppercase">Events</span>
						<button class="btn btn-ghost btn-xs gap-1" onclick={addEvent}><Plus size={9} />Add</button>
					</div>
					{#each localEvents as ev, i (i)}
						<div class="border-base-300 flex flex-col gap-1.5 rounded-lg border p-2">
							<div class="flex gap-1.5">
								<input class="input input-xs min-w-0 flex-1 font-mono" placeholder="signal-id" value={ev.id}
									oninput={(e) => updateEvent(i, 'id', (e.target as HTMLInputElement).value)} />
								<select class="select select-xs w-24 shrink-0" value={ev.type}
									onchange={(e) => updateEvent(i, 'type', (e.target as HTMLSelectElement).value)}>
									{#each ['signal','query','update'] as t (t)}
										<option value={t}>{t}</option>
									{/each}
								</select>
								<button class="btn btn-ghost btn-xs btn-circle text-error shrink-0" onclick={() => removeEvent(i)} aria-label="Remove"><Trash2 size={9} /></button>
							</div>
							<ConditionBuilder
								value={ev.acceptIf ?? ''}
								placeholder={'${ .valid == true }  (optional acceptIf)'}
								availVars={availableVars}
								onchange={(val) => updateEvent(i, 'acceptIf', val)}
							/>
						</div>
					{/each}
				</div>
			{/if}

			<!-- ── RAISE ──────────────────────────────────────────────── -->
			{#if nodeType === 'raise'}
				<div class="flex flex-col gap-2">
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-errtype">error type (URI)</label>
						<input id="np-errtype" class="input input-xs font-mono w-full"
							placeholder="https://serverlessworkflow.io/spec/1.0.0/errors/communication"
							value={f('errorType')}
							oninput={(e) => patch('errorType', (e.target as HTMLInputElement).value)} />
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-errstatus">status code</label>
						<input id="np-errstatus" type="number" class="input input-xs font-mono w-full" placeholder="500"
							value={num('errorStatus', 500)}
							oninput={(e) => patch('errorStatus', Number((e.target as HTMLInputElement).value))} />
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-errtitle">title (optional)</label>
						<input id="np-errtitle" class="input input-xs w-full" placeholder="Communication error"
							value={f('errorTitle')}
							oninput={(e) => patch('errorTitle', (e.target as HTMLInputElement).value)} />
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-base-content/50 text-[10px] font-semibold uppercase">detail (optional)</span>
						<ExpressionInput
							value={f('errorDetail')}
							placeholder={'${ "Failed: " + .message }'}
							availVars={availableVars}
							onchange={(v) => patch('errorDetail', v)}
						/>
					</div>
				</div>
			{/if}

			<!-- ── BYOC (run) ─────────────────────────────────────────── -->
			{#if nodeType === 'run'}
				<div class="flex flex-col gap-1">
					<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-rtype">Type</label>
					<select id="np-rtype" class="select select-xs w-full" value={runType}
						onchange={(e) => { runType = (e.target as HTMLSelectElement).value; patch('runType', runType); }}>
						<option value="script">Script (JS / Python)</option>
						<option value="shell">Shell command</option>
						<option value="container">Container</option>
						<option value="workflow">Child Workflow</option>
					</select>
				</div>

				{#if runType === 'script'}
					<div class="flex gap-2">
						<div class="flex flex-col gap-1 flex-1">
							<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-lang">Language</label>
							<select id="np-lang" class="select select-xs" value={f('language') || 'js'}
								onchange={(e) => patch('language', (e.target as HTMLSelectElement).value)}>
								<option value="js">JavaScript</option>
								<option value="python">Python</option>
							</select>
						</div>
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-code">Inline code</label>
						<textarea id="np-code" class="textarea textarea-xs font-mono text-xs leading-relaxed w-full" rows={7}
							placeholder="// your code here&#10;console.log(process.env.INPUT);"
							value={f('code')}
							oninput={(e) => patch('code', (e.target as HTMLTextAreaElement).value)}></textarea>
					</div>
				{/if}

				{#if runType === 'shell'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-cmd">Command</label>
						<input id="np-cmd" class="input input-xs font-mono w-full" placeholder='echo "hello"'
							value={f('command')}
							oninput={(e) => patch('command', (e.target as HTMLInputElement).value)} />
					</div>
				{/if}

				{#if runType === 'container'}
					<div class="flex flex-col gap-2">
						<div class="flex flex-col gap-1">
							<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-img">Image</label>
							<input id="np-img" class="input input-xs font-mono w-full" placeholder="alpine:latest"
								value={f('image')}
								oninput={(e) => patch('image', (e.target as HTMLInputElement).value)} />
						</div>
						<div class="flex flex-col gap-1">
							<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-pp">Pull policy</label>
							<select id="np-pp" class="select select-xs w-full" value={f('pullPolicy') || 'ifNotPresent'}
								onchange={(e) => patch('pullPolicy', (e.target as HTMLSelectElement).value)}>
								<option value="ifNotPresent">ifNotPresent</option>
								<option value="Always">Always</option>
								<option value="Never">Never</option>
							</select>
						</div>
					</div>
				{/if}

				{#if runType === 'workflow'}
					<div class="flex flex-col gap-2">
						<div class="flex flex-col gap-1">
							<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-rwft">Workflow type</label>
							<input id="np-rwft" class="input input-xs font-mono w-full" placeholder="my-child-workflow"
								value={f('workflowType')}
								oninput={(e) => patch('workflowType', (e.target as HTMLInputElement).value)} />
						</div>
					</div>
				{/if}
			{/if}

			<!-- ── CHILD WORKFLOW ─────────────────────────────────────── -->
			{#if nodeType === 'childWorkflow'}
				<div class="flex flex-col gap-2">
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-[10px] font-semibold uppercase" for="np-cwft">Workflow type</label>
						<input id="np-cwft" class="input input-xs font-mono w-full" placeholder="child-workflow-type"
							value={f('workflowType')}
							oninput={(e) => patch('workflowType', (e.target as HTMLInputElement).value)} />
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-base-content/50 text-[10px] font-semibold uppercase">Input expression</span>
						<ExpressionInput
							value={f('childInput') || '${ . }'}
							placeholder={'${ . }'}
							availVars={availableVars}
							onchange={(v) => patch('childInput', v)}
						/>
					</div>
					<label class="flex cursor-pointer items-center gap-2 text-xs">
						<input type="checkbox" class="checkbox checkbox-xs" checked={bool('await', true)}
							onchange={(e) => patch('await', (e.target as HTMLInputElement).checked)} />
						Await completion
					</label>
				</div>
			{/if}

			<!-- ── END ────────────────────────────────────────────────── -->
			{#if nodeType === 'end'}
				<p class="text-base-content/30 py-4 text-center text-xs">
					Workflow termination — no configuration needed.
				</p>
			{/if}
		</div>

		<!-- ── DATA FLOW SECTION ─────────────────────────────────────────── -->
		{#if hasDataFlow}
			<div class="border-base-200 border-t p-3">
				<p class="text-base-content/50 mb-2 text-[10px] font-semibold uppercase tracking-wider">Data Flow</p>
				<div class="flex flex-col gap-2">
					<div class="flex flex-col gap-0.5">
						<span class="text-base-content/40 font-mono text-[10px]">input.from</span>
						<ExpressionInput
							value={f('inputFrom')}
							placeholder={'${ $context.field }  (override what . is)'}
							availVars={availableVars}
							onchange={(v) => patch('inputFrom', v)}
						/>
					</div>
					<div class="flex flex-col gap-0.5">
						<span class="text-base-content/40 font-mono text-[10px]">output.as</span>
						<ExpressionInput
							value={f('outputAs')}
							placeholder={'${ { key: .field } }  (reshape $output)'}
							availVars={availableVars}
							onchange={(v) => patch('outputAs', v)}
						/>
					</div>
					<div class="flex flex-col gap-0.5">
						<span class="text-base-content/40 font-mono text-[10px]">export.as</span>
						<ExpressionInput
							value={f('exportAs')}
							placeholder={'${ $context + { key: $output } }'}
							availVars={availableVars}
							onchange={(v) => patch('exportAs', v)}
						/>
						<p class="text-base-content/25 text-[9px]">Accumulated into $context — readable by any downstream task</p>
					</div>
				</div>
			</div>
		{/if}

	</div>
</aside>
