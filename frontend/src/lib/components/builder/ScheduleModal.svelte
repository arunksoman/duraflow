<script lang="ts">
	import { untrack } from 'svelte';
	import { X } from '@lucide/svelte';
	import cronstrue from 'cronstrue';
	import CodeMirrorEditor from '$lib/components/editor/CodeMirrorEditor.svelte';
	import CronBuilder from './CronBuilder.svelte';
	import { isValidCronExpression } from '$lib/zigflow-engine/cron';
	import { buildInputSkeleton } from '$lib/zigflow-engine/inputSchema';
	import {
		hasInterval,
		isScheduleActive,
		type WorkflowSchedule
	} from '$lib/zigflow-engine/schedule';
	import type { DurationFields } from '$lib/zigflow-engine/ast';
	import type { InputField } from '$lib/types';

	interface Props {
		schedule: WorkflowSchedule;
		/** Fallback for `scheduleWorkflowName`, which zigflow requires and won't infer. */
		workflowType: string;
		/** The workflow's declared `$input` fields, used to seed a schedule input skeleton. */
		inputFields: InputField[];
		onclose: () => void;
		onupdate: (schedule: WorkflowSchedule) => void;
	}

	let { schedule, workflowType, inputFields, onclose, onupdate }: Props = $props();

	// Seeded once, like the other builder modals: this is the editing copy, and every change is
	// pushed straight back out so the DSL preview stays live while the modal is open.
	let draft = $state<WorkflowSchedule>(
		untrack(() => ({ ...schedule, every: { ...schedule.every } }))
	);

	function patch(next: Partial<WorkflowSchedule>) {
		draft = { ...draft, ...next };
		onupdate({ ...draft, every: { ...draft.every } });
	}

	function setDurationPart(key: keyof DurationFields, raw: string) {
		const parsed = Number(raw);
		const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
		patch({ every: { ...draft.every, [key]: value } });
	}

	/**
	 * Turning the schedule on with nothing selected would write a `schedule:` block Temporal can
	 * never fire, so the first enable picks cron — the shape most people mean by "schedule".
	 */
	function setEnabled(enabled: boolean) {
		if (enabled && !draft.useCron && !draft.useInterval) {
			patch({ enabled, useCron: true });
			return;
		}
		patch({ enabled });
	}

	// `inputDraft` is the editor's text and `draft.input` the parsed value. The text is
	// authoritative while the user types — invalid JSON has no parsed form — so the two are kept in
	// step by the handlers that own them, never by deriving one from the other.
	let inputDraft = $state<string>(
		untrack(() => (schedule.input ? JSON.stringify(schedule.input, null, 2) : ''))
	);
	let inputError = $state<string | null>(null);

	function seedInput() {
		const skeleton = inputFields.length > 0 ? buildInputSkeleton(inputFields) : {};
		inputDraft = JSON.stringify(skeleton, null, 2);
		inputError = null;
		patch({ input: skeleton });
	}

	function handleInputChange(text: string) {
		inputDraft = text;
		if (!text.trim()) {
			inputError = null;
			patch({ input: null });
			return;
		}
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				inputError = 'Schedule input must be a JSON object.';
				return;
			}
			inputError = null;
			patch({ input: parsed as Record<string, unknown> });
		} catch {
			inputError = 'Not valid JSON.';
		}
	}

	const DURATION_PARTS: { key: keyof DurationFields; label: string }[] = [
		{ key: 'days', label: 'Days' },
		{ key: 'hours', label: 'Hours' },
		{ key: 'minutes', label: 'Minutes' },
		{ key: 'seconds', label: 'Seconds' }
	];

	const active = $derived(isScheduleActive(draft));
	const cronValid = $derived(!draft.useCron || isValidCronExpression(draft.cron));
	const intervalSet = $derived(!draft.useInterval || hasInterval(draft.every));

	const summary = $derived.by(() => {
		if (!draft.enabled) return 'Off — this workflow only runs when you start it.';
		if (!draft.useCron && !draft.useInterval) return 'Pick an interval or a cron expression.';
		const parts: string[] = [];
		if (draft.useInterval && hasInterval(draft.every)) {
			const spelled = DURATION_PARTS.filter(({ key }) => Number(draft.every[key] ?? 0) > 0)
				.map(({ key, label }) => `${draft.every[key]} ${label.toLowerCase()}`)
				.join(' ');
			parts.push(`every ${spelled}`);
		}
		if (draft.useCron && isValidCronExpression(draft.cron)) {
			try {
				parts.push(cronstrue.toString(draft.cron, { verbose: false }).toLowerCase());
			} catch {
				parts.push(draft.cron);
			}
		}
		return parts.length > 0 ? `Runs ${parts.join(', and ')} (UTC).` : 'Incomplete schedule.';
	});
</script>

<div class="modal modal-open z-50">
	<div class="modal-box max-w-2xl">
		<div class="mb-4 flex items-start justify-between gap-4">
			<div>
				<h3 class="font-semibold">Schedule</h3>
				<p class="text-base-content/40 text-xs">
					Saved into the DSL as <code>schedule:</code>. The worker registers it with Temporal on
					every save, and Temporal evaluates it in UTC.
				</p>
			</div>
			<button class="btn btn-ghost btn-sm btn-circle" onclick={onclose} aria-label="Close">
				<X size={15} />
			</button>
		</div>

		<div class="flex max-h-[72vh] flex-col gap-5 overflow-y-auto pr-1">
			<!-- ── Master switch ───────────────────────────────────────────── -->
			<div class="border-base-300 flex items-center justify-between gap-4 rounded-lg border p-3">
				<div class="min-w-0">
					<p class="text-sm font-medium">Run on a schedule</p>
					<p class="text-base-content/50 mt-0.5 text-xs">{summary}</p>
				</div>
				<input
					type="checkbox"
					class="toggle toggle-primary shrink-0"
					checked={draft.enabled}
					onchange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
					aria-label="Run on a schedule"
				/>
			</div>

			<div
				class="flex flex-col gap-5"
				class:pointer-events-none={!draft.enabled}
				class:opacity-40={!draft.enabled}
			>
				<!-- ── Interval ──────────────────────────────────────────────── -->
				<section class="flex flex-col gap-2">
					<label class="flex cursor-pointer items-center gap-2">
						<input
							type="checkbox"
							class="checkbox checkbox-sm"
							checked={draft.useInterval}
							onchange={(e) => patch({ useInterval: (e.target as HTMLInputElement).checked })}
						/>
						<span class="text-sm font-medium">Repeat every</span>
						<span class="text-base-content/40 text-xs"
							>fixed interval — <code>schedule.every</code></span
						>
					</label>
					{#if draft.useInterval}
						<div class="grid grid-cols-4 gap-2 pl-7">
							{#each DURATION_PARTS as part (part.key)}
								<label class="flex flex-col gap-1">
									<span class="text-base-content/60 text-[11px] font-medium">{part.label}</span>
									<input
										type="number"
										min="0"
										class="input input-sm w-full"
										value={draft.every[part.key] ?? 0}
										onchange={(e) =>
											setDurationPart(part.key, (e.target as HTMLInputElement).value)}
									/>
								</label>
							{/each}
						</div>
						{#if !intervalSet}
							<p class="text-error pl-7 text-xs">Set at least one non-zero value.</p>
						{/if}
					{/if}
				</section>

				<!-- ── Cron ──────────────────────────────────────────────────── -->
				<section class="flex flex-col gap-2">
					<label class="flex cursor-pointer items-center gap-2">
						<input
							type="checkbox"
							class="checkbox checkbox-sm"
							checked={draft.useCron}
							onchange={(e) => patch({ useCron: (e.target as HTMLInputElement).checked })}
						/>
						<span class="text-sm font-medium">Cron expression</span>
						<span class="text-base-content/40 text-xs"
							>calendar times — <code>schedule.cron</code></span
						>
					</label>
					{#if draft.useCron}
						<div class="pl-7">
							<CronBuilder value={draft.cron} onchange={(cron) => patch({ cron })} />
						</div>
					{/if}
				</section>

				{#if draft.useCron && draft.useInterval}
					<p class="text-base-content/50 text-xs">
						Both are set — Temporal fires the workflow on the interval <em>and</em> at every cron time.
					</p>
				{/if}

				<!-- ── Schedule input & identity ─────────────────────────────── -->
				<details class="border-base-300 rounded-lg border">
					<summary class="cursor-pointer px-3 py-2 text-sm font-medium">
						Schedule input &amp; identity
					</summary>
					<div class="flex flex-col gap-4 border-t border-base-300 p-3">
						<div class="flex flex-col gap-1">
							<div class="flex items-center justify-between gap-2">
								<span class="text-base-content/60 text-[11px] font-medium">
									Schedule input — the argument each scheduled run starts with
								</span>
								<button type="button" class="btn btn-ghost btn-xs" onclick={seedInput}>
									{inputFields.length > 0 ? 'Fill from $input schema' : 'Start from {}'}
								</button>
							</div>
							<div class="border-base-300 h-40 overflow-hidden rounded-lg border">
								<CodeMirrorEditor value={inputDraft} language="json" onchange={handleInputChange} />
							</div>
							{#if inputError}
								<p class="text-error text-xs">{inputError}</p>
							{:else}
								<p class="text-base-content/35 text-[10px]">
									Written to <code>document.metadata.scheduleInput</code>. Values may use
									<code>{'${ $env.NAME }'}</code> to read the worker's environment. Leave empty for no
									input.
								</p>
							{/if}
						</div>

						<div class="grid grid-cols-2 gap-3">
							<label class="flex flex-col gap-1">
								<span class="text-base-content/60 text-[11px] font-medium">Workflow to trigger</span
								>
								<input
									class="input input-sm w-full font-mono"
									value={draft.workflowName}
									placeholder={workflowType}
									onchange={(e) =>
										patch({ workflowName: (e.target as HTMLInputElement).value.trim() })}
								/>
								<span class="text-base-content/35 text-[10px]">
									Defaults to this document's <code>workflowType</code>.
								</span>
							</label>
							<label class="flex flex-col gap-1">
								<span class="text-base-content/60 text-[11px] font-medium">Schedule ID</span>
								<input
									class="input input-sm w-full font-mono"
									value={draft.scheduleId}
									placeholder={`zigflow_${workflowType}`}
									onchange={(e) =>
										patch({ scheduleId: (e.target as HTMLInputElement).value.trim() })}
								/>
								<span class="text-base-content/35 text-[10px]">
									The Temporal schedule this workflow owns and replaces on every save.
								</span>
							</label>
						</div>
					</div>
				</details>
			</div>

			{#if draft.enabled && (!cronValid || !intervalSet || !active)}
				<div class="alert alert-warning py-2 text-xs">
					<span>The schedule is incomplete, so nothing is written to the DSL yet.</span>
				</div>
			{/if}
		</div>

		<div class="modal-action">
			<button class="btn btn-sm" onclick={onclose}>Done</button>
		</div>
	</div>
	<form method="dialog" class="modal-backdrop">
		<button onclick={onclose}>close</button>
	</form>
</div>
