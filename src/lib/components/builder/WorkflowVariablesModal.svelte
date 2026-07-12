<script lang="ts">
	import { untrack } from 'svelte';
	import { Plus, Trash2, X } from '@lucide/svelte';
	import type { WorkflowMeta, EnvVar } from '$lib/types';

	interface Props {
		meta: WorkflowMeta;
		onclose: () => void;
		onupdate: (patch: Partial<WorkflowMeta>) => void;
	}

	let { meta, onclose, onupdate }: Props = $props();

	let envVars = $state<EnvVar[]>(untrack(() => (meta.envVars ?? []).map((e) => ({ ...e }))));
	let workflowType = $state<string>(untrack(() => meta.workflowType ?? ''));
	let taskQueue = $state<string>(untrack(() => meta.taskQueue ?? ''));
	let version = $state<string>(untrack(() => meta.version ?? '0.1.0'));

	function saveEnvVars() {
		onupdate({ envVars: envVars.map((e) => ({ ...e })) });
	}

	function addEnvVar() {
		envVars = [...envVars, { name: '', description: '', example: '' }];
		saveEnvVars();
	}
	function removeEnvVar(i: number) {
		envVars = envVars.filter((_, idx) => idx !== i);
		saveEnvVars();
	}
	function updateEnvVar<K extends keyof EnvVar>(i: number, key: K, val: EnvVar[K]) {
		envVars = envVars.map((e, idx) => (idx === i ? { ...e, [key]: val } : e));
		saveEnvVars();
	}
</script>

<div class="modal modal-open z-50">
	<div class="modal-box max-w-2xl">
		<!-- Header -->
		<div class="mb-4 flex items-center justify-between">
			<div>
				<h3 class="font-semibold">Workflow Variables</h3>
				<p class="text-base-content/40 text-xs">
					Document metadata and worker environment variables — the workflow's <code>$input</code>
					schema is edited on the Start node itself.
				</p>
			</div>
			<button class="btn btn-ghost btn-sm btn-circle" onclick={onclose} aria-label="Close">
				<X size={15} />
			</button>
		</div>

		<div class="flex max-h-[72vh] flex-col gap-6 overflow-y-auto pr-1">
			<!-- ── Document metadata ─────────────────────────────────────── -->
			<section>
				<h4 class="text-base-content/70 mb-2 text-xs font-semibold uppercase tracking-wider">
					Document
				</h4>
				<div class="grid grid-cols-2 gap-3">
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-xs" for="wv-wftype">workflowType</label>
						<input
							id="wv-wftype"
							class="input input-sm font-mono text-xs"
							placeholder="order-fulfillment"
							value={workflowType}
							oninput={(e) => {
								workflowType = (e.target as HTMLInputElement).value;
								onupdate({ workflowType });
							}}
						/>
						<span class="text-base-content/30 text-[10px]"
							>RFC 1123 — letters, digits, hyphens only</span
						>
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-xs" for="wv-tq">taskQueue</label>
						<input
							id="wv-tq"
							class="input input-sm font-mono text-xs"
							placeholder="default"
							value={taskQueue}
							oninput={(e) => {
								taskQueue = (e.target as HTMLInputElement).value;
								onupdate({ taskQueue });
							}}
						/>
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-base-content/50 text-xs" for="wv-ver">version</label>
						<input
							id="wv-ver"
							class="input input-sm font-mono text-xs"
							placeholder="0.1.0"
							value={version}
							oninput={(e) => {
								version = (e.target as HTMLInputElement).value;
								onupdate({ version });
							}}
						/>
					</div>
				</div>
			</section>

			<!-- ── $env variables ────────────────────────────────────────── -->
			<section>
				<div class="mb-2 flex items-center justify-between">
					<div>
						<h4 class="text-base-content/70 text-xs font-semibold uppercase tracking-wider">
							<code class="text-warning font-mono">$env</code> Variables
						</h4>
						<p class="text-base-content/40 mt-0.5 text-[10px]">
							Worker environment variables prefixed <code>ZIGGY_</code> — e.g. define
							<code>API_BASE</code> → use as
							<code class="text-warning">${'${ $env.API_BASE }'}</code>
						</p>
					</div>
					<button class="btn btn-ghost btn-xs gap-1" onclick={addEnvVar}>
						<Plus size={10} />
						Add variable
					</button>
				</div>

				{#if envVars.length === 0}
					<p class="text-base-content/30 py-3 text-center text-xs">
						No env vars defined — add them to enable hints like
						<code class="text-warning">${'${ $env.API_BASE }'}</code> in expression fields.
					</p>
				{:else}
					<div class="flex flex-col gap-2">
						{#each envVars as env, i (i)}
							<div
								class="border-base-300 grid grid-cols-[80px_1fr_1fr_auto] items-end gap-2 rounded-lg border p-2"
							>
								<div class="flex flex-col gap-0.5">
									<span class="text-base-content/40 text-[10px]">ZIGGY_</span>
									<input
										class="input input-xs font-mono"
										placeholder="API_BASE"
										value={env.name}
										oninput={(e) => updateEnvVar(i, 'name', (e.target as HTMLInputElement).value)}
									/>
								</div>
								<div class="flex flex-col gap-0.5">
									<span class="text-base-content/40 text-[10px]">description</span>
									<input
										class="input input-xs"
										placeholder="Base URL for API"
										value={env.description ?? ''}
										oninput={(e) =>
											updateEnvVar(i, 'description', (e.target as HTMLInputElement).value)}
									/>
								</div>
								<div class="flex flex-col gap-0.5">
									<span class="text-base-content/40 text-[10px]">example value</span>
									<input
										class="input input-xs font-mono"
										placeholder="https://api.example.com"
										value={env.example ?? ''}
										oninput={(e) =>
											updateEnvVar(i, 'example', (e.target as HTMLInputElement).value)}
									/>
								</div>
								<button
									class="btn btn-ghost btn-xs btn-circle text-error"
									onclick={() => removeEnvVar(i)}
									aria-label="Remove env var"
								>
									<Trash2 size={10} />
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- ── Quick reference ───────────────────────────────────────── -->
			<section class="border-base-300 rounded-lg border p-3">
				<h4 class="text-base-content/50 mb-2 text-[10px] font-semibold uppercase tracking-wider">
					Runtime Variable Reference
				</h4>
				<div class="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px]">
					<span
						><code class="text-primary">$input</code><span class="text-base-content/40">
							— trigger payload (immutable)</span
						></span
					>
					<span
						><code class="text-success">$data.&lt;key&gt;</code><span class="text-base-content/40">
							— values from Set tasks</span
						></span
					>
					<span
						><code class="text-warning">$env.&lt;NAME&gt;</code><span class="text-base-content/40">
							— ZIGGY_* env vars</span
						></span
					>
					<span
						><code class="text-info">$context</code><span class="text-base-content/40">
							— accumulated via export.as</span
						></span
					>
					<span
						><code class="text-secondary">$output</code><span class="text-base-content/40">
							— previous task's raw result</span
						></span
					>
					<span
						><code class="text-base-content/40">.</code><span class="text-base-content/40">
							— shorthand for $output in jq</span
						></span
					>
				</div>
			</section>
		</div>

		<div class="modal-action mt-4">
			<button class="btn btn-sm btn-primary" onclick={onclose}>Done</button>
		</div>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button onclick={onclose}>close</button>
	</form>
</div>
