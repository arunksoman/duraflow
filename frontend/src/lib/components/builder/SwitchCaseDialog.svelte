<script lang="ts">
	import { GitBranch, Trash2 } from '@lucide/svelte';
	import type { Node, Edge } from '@xyflow/svelte';
	import type { WorkflowMeta } from '$lib/types';
	import type { CaseEntry } from './builderConfig';
	import { availableVarsAt } from './availableVars';
	import { OWNER_SCOPE_TAG } from '$lib/zigflow-engine/inlineScopeView';
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

	/**
	 * A `then:` may only name a task at the switch's own nesting depth (Zigflow spec), and the
	 * canvas shows every scope inlined as one flat list — so the picker is filtered to the switch's
	 * own scope, or it would offer targets the DSL can never reach. Named workflows are the
	 * exception: they are declared at the document's top level and reachable from anywhere.
	 */
	const targetOptions = $derived(
		nodes
			.filter(
				(n) =>
					n.id !== switchNode.id &&
					n.type !== 'start' &&
					n.type !== 'end' &&
					(n.type === 'workflow' ||
						(n.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] ===
							(switchNode.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG])
			)
			.map((n) => ({
				value: n.id,
				label: n.type === 'workflow' ? `${n.data?.label} (workflow)` : `${n.data?.label ?? n.type}`
			}))
	);
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
