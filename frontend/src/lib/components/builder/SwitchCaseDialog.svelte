<script lang="ts">
	import { GitBranch, Trash2 } from '@lucide/svelte';
	import type { Node, Edge } from '@xyflow/svelte';
	import type { WorkflowMeta } from '$lib/types';
	import type { CaseEntry } from './builderConfig';
	import { availableVarsAt } from './availableVars';
	import { caseTargetOptions } from '$lib/zigflow-engine/switchCases';
	import SwitchCaseEditor from './SwitchCaseEditor.svelte';

	interface Props {
		/** The switch the case belongs to. */
		switchNode: Node;
		caseEntry: CaseEntry;
		nodes: Node[];
		edges: Edge[];
		workflowMeta: WorkflowMeta;
		/** True when the case was just created by dragging an edge — Cancel then undoes the whole thing. */
		isNew?: boolean;
		onchange: (patch: Partial<CaseEntry>) => void;
		ondelete: () => void;
		onclose: () => void;
	}

	let {
		switchNode,
		caseEntry,
		nodes,
		edges,
		workflowMeta,
		isNew = false,
		onchange,
		ondelete,
		onclose
	}: Props = $props();

	const availVars = $derived(availableVarsAt(switchNode, nodes, edges, workflowMeta));

	const targetOptions = $derived(caseTargetOptions(switchNode, nodes));
</script>

<div class="modal modal-open z-50">
	<div class="modal-box w-full max-w-md">
		<div class="mb-3 flex items-start justify-between gap-3">
			<div class="flex items-center gap-2">
				<div class="rounded p-1" style="background:#06b6d41a;color:#06b6d4">
					<GitBranch size={15} />
				</div>
				<div>
					<h3 class="text-sm font-semibold">{isNew ? 'New case' : 'Edit case'}</h3>
					<p class="text-base-content/40 text-[10px]">
						on <span class="font-mono">{switchNode.data?.label ?? 'switch'}</span>
					</p>
				</div>
			</div>
			<button class="btn btn-ghost btn-xs btn-circle" onclick={onclose} aria-label="Close">✕</button
			>
		</div>

		<SwitchCaseEditor {caseEntry} {availVars} {targetOptions} {onchange} />

		<div class="modal-action mt-4">
			<button class="btn btn-ghost btn-sm text-error gap-1" onclick={ondelete}>
				<Trash2 size={13} />
				{isNew ? 'Discard' : 'Delete case'}
			</button>
			<button class="btn btn-primary btn-sm" onclick={onclose}>Done</button>
		</div>
	</div>
	<button class="modal-backdrop" onclick={onclose} aria-label="Close"></button>
</div>
