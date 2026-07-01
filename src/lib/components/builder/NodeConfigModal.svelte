<script lang="ts">
	import { untrack } from 'svelte';
	import type { Node } from '@xyflow/svelte';
	import { Plus, Trash2, X } from '@lucide/svelte';
	import { NODE_META, type VarEntry, type CaseEntry } from './builderConfig';
	import type { WorkflowNodeType } from '$lib/types';

	interface Props {
		node: Node;
		onclose: () => void;
		onupdate: (id: string, patch: Record<string, unknown>) => void;
	}

	let { node, onclose, onupdate }: Props = $props();

	const nodeType = $derived<WorkflowNodeType>(
		node && (node.type ?? 'task') in NODE_META ? (node.type as WorkflowNodeType) : 'task'
	);
	const meta = $derived(NODE_META[nodeType]);
	const HeaderIcon = $derived(meta.icon);

	// Local copies — initialized once (modal is destroyed/recreated on each open, so untrack is correct)
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

	let runType = $state<string>(untrack(() => (node?.data?.runType as string) ?? 'script'));

	function field(key: string): string {
		return (node?.data[key] as string) ?? '';
	}

	function numField(key: string, fallback: number): number {
		const v = node?.data[key];
		return typeof v === 'number' ? v : fallback;
	}

	function patch(key: string, value: unknown) {
		if (node) onupdate(node.id, { [key]: value });
	}

	function saveVars() {
		patch('variables', localVars.map((v) => ({ ...v })));
	}

	function saveCases() {
		patch('cases', localCases.map((c) => ({ ...c })));
	}

	function addVar() {
		localVars = [...localVars, { key: '', value: '' }];
		saveVars();
	}

	function removeVar(i: number) {
		localVars = localVars.filter((_, idx) => idx !== i);
		saveVars();
	}

	function updateVar(i: number, f: keyof VarEntry, val: string) {
		localVars = localVars.map((v, idx) => (idx === i ? { ...v, [f]: val } : v));
		saveVars();
	}

	function addCase() {
		localCases = [...localCases, { name: `case${localCases.length + 1}`, condition: '', then: 'continue' }];
		saveCases();
	}

	function removeCase(i: number) {
		localCases = localCases.filter((_, idx) => idx !== i);
		saveCases();
	}

	function updateCase(i: number, f: keyof CaseEntry, val: string) {
		localCases = localCases.map((c, idx) => (idx === i ? { ...c, [f]: val } : c));
		saveCases();
	}
</script>

<div class="modal modal-open z-50">
	<div class="modal-box max-w-md">
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
				<h3 class="text-sm font-semibold">{meta.label} Config</h3>
				<p class="text-base-content/40 truncate text-xs">{meta.description}</p>
			</div>
			<button class="btn btn-ghost btn-sm btn-circle" onclick={onclose} aria-label="Close">
				<X size={15} />
			</button>
		</div>

		<div class="divider my-0 mb-3"></div>

		<div class="max-h-[60vh] overflow-y-auto pr-1">
			<div class="flex flex-col gap-3">
				<!-- Label (all except start / end) -->
				{#if nodeType !== 'start' && nodeType !== 'end'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-label">Label</label>
						<input
							id="cfg-label"
							class="input input-sm w-full"
							value={field('label')}
							oninput={(e) => patch('label', (e.target as HTMLInputElement).value)}
						/>
					</div>
				{/if}

				<!-- task -->
				{#if nodeType === 'task'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-method">Method</label>
						<select
							id="cfg-method"
							class="select select-sm w-full"
							value={field('method') || 'get'}
							onchange={(e) => patch('method', (e.target as HTMLSelectElement).value)}
						>
							{#each ['get', 'post', 'put', 'patch', 'delete'] as m (m)}
								<option value={m}>{m.toUpperCase()}</option>
							{/each}
						</select>
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-ep">Endpoint</label>
						<input
							id="cfg-ep"
							class="input input-sm w-full font-mono text-xs"
							placeholder="https://api.example.com/endpoint"
							value={field('endpoint')}
							oninput={(e) => patch('endpoint', (e.target as HTMLInputElement).value)}
						/>
					</div>
				{/if}

				{#if nodeType === 'task'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-timeout">Timeout</label>
						<input
							id="cfg-timeout"
							class="input input-sm w-full"
							placeholder="30s"
							value={field('timeout')}
							oninput={(e) => patch('timeout', (e.target as HTMLInputElement).value)}
						/>
					</div>
				{/if}

				<!-- for -->
				{#if nodeType === 'for'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-each">Each variable</label>
						<input
							id="cfg-each"
							class="input input-sm w-full font-mono text-xs"
							value={field('each') || 'item'}
							oninput={(e) => patch('each', (e.target as HTMLInputElement).value)}
						/>
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-coll">Collection</label>
						<input
							id="cfg-coll"
							class="input input-sm w-full font-mono text-xs"
							value={field('collection') || 'items'}
							oninput={(e) => patch('collection', (e.target as HTMLInputElement).value)}
						/>
					</div>
				{/if}

				<!-- listen / raise -->
				{#if nodeType === 'listen' || nodeType === 'raise'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-evt">Event type</label>
						<input
							id="cfg-evt"
							class="input input-sm w-full font-mono text-xs"
							placeholder="com.example.my-event"
							value={field('eventType')}
							oninput={(e) => patch('eventType', (e.target as HTMLInputElement).value)}
						/>
					</div>
				{/if}

				<!-- set / start — multi-variable editor -->
				{#if nodeType === 'set' || nodeType === 'start'}
					<div class="flex flex-col gap-2">
						<div class="flex items-center justify-between">
							<span class="text-base-content/60 text-xs font-medium">Variables</span>
							<button class="btn btn-ghost btn-xs gap-1" onclick={addVar}>
								<Plus size={10} />
								Add
							</button>
						</div>
						{#if localVars.length === 0}
							<p class="text-base-content/30 py-3 text-center text-xs">
								No variables yet — click Add.
							</p>
						{/if}
						{#each localVars as v, i (i)}
							<div class="flex items-center gap-1">
								<input
									class="input input-xs w-28 shrink-0 font-mono"
									placeholder="key"
									value={v.key}
									oninput={(e) =>
										updateVar(i, 'key', (e.target as HTMLInputElement).value)}
								/>
								<span class="text-base-content/30 shrink-0 text-xs">=</span>
								<input
									class="input input-xs min-w-0 flex-1 font-mono"
									placeholder={'${ .value }'}
									value={v.value}
									oninput={(e) =>
										updateVar(i, 'value', (e.target as HTMLInputElement).value)}
								/>
								<button
									class="btn btn-ghost btn-xs btn-circle text-error shrink-0"
									onclick={() => removeVar(i)}
									aria-label="Remove variable"
								>
									<Trash2 size={10} />
								</button>
							</div>
						{/each}
					</div>
				{/if}

				<!-- switch — named cases editor -->
				{#if nodeType === 'switch'}
					<div class="flex flex-col gap-2">
						<div class="flex items-center justify-between">
							<span class="text-base-content/60 text-xs font-medium">Cases</span>
							<button class="btn btn-ghost btn-xs gap-1" onclick={addCase}>
								<Plus size={10} />
								Add case
							</button>
						</div>
						{#each localCases as c, i (i)}
							<div class="border-base-300 flex flex-col gap-1.5 rounded-lg border p-2">
								<div class="flex items-center gap-1.5">
									<span class="text-base-content/40 w-12 shrink-0 text-xs">Name</span>
									<input
										class="input input-xs min-w-0 flex-1 font-mono"
										placeholder="case-name"
										value={c.name}
										oninput={(e) =>
											updateCase(i, 'name', (e.target as HTMLInputElement).value)}
									/>
									<button
										class="btn btn-ghost btn-xs btn-circle text-error shrink-0"
										onclick={() => removeCase(i)}
										aria-label="Remove case"
									>
										<Trash2 size={10} />
									</button>
								</div>
								<div class="flex items-center gap-1.5">
									<span class="text-base-content/40 w-12 shrink-0 text-xs">When</span>
									<input
										class="input input-xs min-w-0 flex-1 font-mono"
										placeholder={'${ .status == "ok" }  (blank = default)'}
										value={c.condition}
										oninput={(e) =>
											updateCase(i, 'condition', (e.target as HTMLInputElement).value)}
									/>
								</div>
								<div class="flex items-center gap-1.5">
									<span class="text-base-content/40 w-12 shrink-0 text-xs">Then</span>
									<input
										class="input input-xs min-w-0 flex-1 font-mono"
										placeholder="task-name, continue, end, exit"
										value={c.then}
										oninput={(e) =>
											updateCase(i, 'then', (e.target as HTMLInputElement).value)}
									/>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<!-- wait -->
				{#if nodeType === 'wait'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-dur"
							>Duration (seconds)</label
						>
						<input
							id="cfg-dur"
							type="number"
							min="1"
							class="input input-sm w-full"
							value={numField('duration', 30)}
							oninput={(e) => patch('duration', Number((e.target as HTMLInputElement).value))}
						/>
					</div>
				{/if}

				<!-- run / BYOC -->
				{#if nodeType === 'run'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-run-type">Type</label>
						<select
							id="cfg-run-type"
							class="select select-sm w-full"
							value={runType}
							onchange={(e) => {
								runType = (e.target as HTMLSelectElement).value;
								patch('runType', runType);
							}}
						>
							<option value="script">Script (JS / Python)</option>
							<option value="shell">Shell command</option>
							<option value="container">Container</option>
							<option value="workflow">Child Workflow</option>
						</select>
					</div>

					{#if runType === 'script'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="cfg-lang"
								>Language</label
							>
							<select
								id="cfg-lang"
								class="select select-sm w-full"
								value={field('language') || 'js'}
								onchange={(e) => patch('language', (e.target as HTMLSelectElement).value)}
							>
								<option value="js">JavaScript</option>
								<option value="python">Python</option>
							</select>
						</div>
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="cfg-code">Code</label>
							<textarea
								id="cfg-code"
								class="textarea textarea-sm w-full font-mono text-xs leading-relaxed"
								rows={8}
								placeholder="// your code here"
								value={field('code')}
								oninput={(e) => patch('code', (e.target as HTMLTextAreaElement).value)}
							></textarea>
						</div>
					{/if}

					{#if runType === 'shell'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="cfg-cmd">Command</label>
							<input
								id="cfg-cmd"
								class="input input-sm w-full font-mono text-xs"
								placeholder='echo "hello from shell"'
								value={field('command')}
								oninput={(e) => patch('command', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}

					{#if runType === 'container'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="cfg-img">Image</label>
							<input
								id="cfg-img"
								class="input input-sm w-full font-mono text-xs"
								placeholder="alpine:latest"
								value={field('image')}
								oninput={(e) => patch('image', (e.target as HTMLInputElement).value)}
							/>
						</div>
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="cfg-pp"
								>Pull Policy</label
							>
							<select
								id="cfg-pp"
								class="select select-sm w-full"
								value={field('pullPolicy') || 'ifNotPresent'}
								onchange={(e) => patch('pullPolicy', (e.target as HTMLSelectElement).value)}
							>
								<option value="ifNotPresent">ifNotPresent</option>
								<option value="Always">Always</option>
								<option value="Never">Never</option>
							</select>
						</div>
					{/if}

					{#if runType === 'workflow'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="cfg-wft"
								>Workflow type</label
							>
							<input
								id="cfg-wft"
								class="input input-sm w-full font-mono text-xs"
								placeholder="my-workflow-type"
								value={field('workflowType')}
								oninput={(e) => patch('workflowType', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}
				{/if}

				<!-- childWorkflow -->
				{#if nodeType === 'childWorkflow'}
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="cfg-wftype"
							>Workflow type</label
						>
						<input
							id="cfg-wftype"
							class="input input-sm w-full font-mono text-xs"
							placeholder="my-workflow-type"
							value={field('workflowType')}
							oninput={(e) => patch('workflowType', (e.target as HTMLInputElement).value)}
						/>
					</div>
				{/if}

				<!-- end — no config -->
				{#if nodeType === 'end'}
					<p class="text-base-content/40 py-3 text-center text-xs">
						Workflow termination — no config needed.
					</p>
				{/if}
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
