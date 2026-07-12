import type { Component } from 'svelte';
import {
	Bell,
	CheckSquare,
	CirclePlay,
	Clock,
	Code2,
	GitBranch,
	GitFork,
	Globe,
	OctagonX,
	Pencil,
	Repeat,
	ShieldAlert,
	TriangleAlert,
	Workflow
} from '@lucide/svelte';
import type { WorkflowNodeType } from '$lib/types';

export interface VarEntry {
	key: string;
	value: string;
}

/** Switch case. `then` holds a flow directive OR a node.id (resolved to slug at DSL time). */
export interface CaseEntry {
	name: string;
	condition: string;
	then: string;
}

/** Event filter for Listen task. */
export interface EventEntry {
	id: string;
	type: 'signal' | 'query' | 'update';
	data?: string;
	acceptIf?: string;
}

/** A named Fork branch — each branch's body is authored via drill-in navigation. */
export interface BranchEntry {
	/** Stable id used as the drill-in scope key — independent of the mutable `name`. */
	id: string;
	name: string;
}

export type PullPolicy = 'always' | 'never' | 'ifNotPresent';

/**
 * Shared fields present on every real task node (start/end excepted): the `if` guard maps to
 * Zigflow's `TaskBase.if` (skip this task unless truthy — shared by every task type, not a
 * standalone node), plus the `output.as` / `export.as` data-flow fields. Note: Zigflow's `input`
 * task property only supports a `schema` (for input validation) — there is no `input.from`
 * equivalent, so this shape intentionally has no "input" data-flow field.
 */
export interface DataFlow {
	if: string;
	outputAs: string;
	exportAs: string;
}

const EMPTY_FLOW: DataFlow = { if: '', outputAs: '', exportAs: '' };

export interface NodeMeta {
	label: string;
	description: string;
	icon: Component<{ size?: number; class?: string }>;
	color: string;
	category: 'action' | 'control' | 'event' | 'structure' | 'terminal';
	showInPalette: boolean;
	defaultData: Record<string, unknown>;
}

export const NODE_META: Record<WorkflowNodeType, NodeMeta> = {
	start: {
		label: 'Start',
		description: 'Workflow entry point — optionally initialise $data variables',
		icon: CirclePlay,
		color: '#22c55e',
		category: 'terminal',
		showInPalette: false,
		defaultData: { label: 'Start', variables: [] as VarEntry[] }
	},
	end: {
		label: 'End',
		description: 'Workflow termination',
		icon: OctagonX,
		color: '#94a3b8',
		category: 'terminal',
		showInPalette: true,
		defaultData: { label: 'End' }
	},
	call: {
		label: 'REST',
		description: 'HTTP REST call — supports $env, $input, $data, $context in all fields',
		icon: Globe,
		color: '#6366f1',
		category: 'action',
		showInPalette: true,
		defaultData: {
			label: 'REST Call',
			method: 'get',
			endpoint: '',
			headers: [] as VarEntry[],
			query: [] as VarEntry[],
			body: '',
			output: 'content',
			redirect: false,
			...EMPTY_FLOW
		}
	},
	set: {
		label: 'Set',
		description: 'Write key-value pairs into $data — accessible as ${ $data.<key> } downstream',
		icon: Pencil,
		color: '#10b981',
		category: 'action',
		showInPalette: true,
		defaultData: {
			label: 'Set Variables',
			variables: [{ key: 'result', value: '${ . }' }] as VarEntry[],
			...EMPTY_FLOW
		}
	},
	switch: {
		label: 'Switch',
		description: 'Conditional branching — cases evaluated in order, first match wins',
		icon: GitBranch,
		color: '#06b6d4',
		category: 'control',
		showInPalette: true,
		defaultData: {
			label: 'Switch',
			cases: [] as CaseEntry[],
			...EMPTY_FLOW
		}
	},
	for: {
		label: 'For',
		description: 'Iterate over a collection — each iteration runs as a child workflow',
		icon: Repeat,
		color: '#14b8a6',
		category: 'control',
		showInPalette: true,
		defaultData: {
			label: 'For Each',
			each: 'item',
			at: 'index',
			in: '${ $input.items }',
			while: '',
			...EMPTY_FLOW
		}
	},
	fork: {
		label: 'Fork',
		description: 'Run branches in parallel — compete mode returns only the fastest',
		icon: GitFork,
		color: '#f97316',
		category: 'control',
		showInPalette: true,
		defaultData: { label: 'Fork', compete: false, branches: [] as BranchEntry[], ...EMPTY_FLOW }
	},
	try: {
		label: 'Try',
		description: 'Wrap tasks in error handling — catch block runs on any failure',
		icon: ShieldAlert,
		color: '#ef4444',
		category: 'control',
		showInPalette: true,
		defaultData: { label: 'Try', catchAs: 'error', ...EMPTY_FLOW }
	},
	wait: {
		label: 'Wait',
		description: 'Durable timer — pause by duration or until a specific timestamp',
		icon: Clock,
		color: '#f59e0b',
		category: 'event',
		showInPalette: true,
		defaultData: {
			label: 'Wait',
			waitMode: 'duration',
			seconds: 30,
			minutes: 0,
			hours: 0,
			days: 0,
			until: '',
			...EMPTY_FLOW
		}
	},
	listen: {
		label: 'Listen',
		description: 'Wait for Temporal signals, queries, or updates',
		icon: Bell,
		color: '#a855f7',
		category: 'event',
		showInPalette: true,
		defaultData: {
			label: 'Listen',
			strategy: 'one',
			events: [{ id: 'my-signal', type: 'signal' }] as EventEntry[],
			...EMPTY_FLOW
		}
	},
	raise: {
		label: 'Raise',
		description: 'Throw a typed error (RFC 7807 Problem Details) — terminates current path',
		icon: TriangleAlert,
		color: '#dc2626',
		category: 'event',
		showInPalette: true,
		defaultData: {
			label: 'Raise Error',
			errorType: 'https://serverlessworkflow.io/spec/1.0.0/errors/communication',
			errorStatus: 500,
			errorTitle: '',
			errorDetail: '',
			errorInstance: '',
			...EMPTY_FLOW
		}
	},
	run: {
		label: 'BYOC',
		description: 'Bring Your Own Code — script, shell command, or container',
		icon: Code2,
		color: '#6b7280',
		category: 'action',
		showInPalette: true,
		defaultData: {
			label: 'My Code',
			runType: 'script',
			language: 'js',
			code: '// your code here\nconsole.log("hello from workflow");',
			command: '',
			image: '',
			pullPolicy: 'ifNotPresent',
			workflowType: '',
			...EMPTY_FLOW
		}
	},
	do: {
		label: 'Do',
		description: 'Sequential task group — shown when hand-written DSL groups tasks explicitly',
		icon: CheckSquare,
		color: '#64748b',
		category: 'control',
		showInPalette: false,
		defaultData: { label: 'Do', ...EMPTY_FLOW }
	},
	childWorkflow: {
		label: 'Child Flow',
		description: 'Invoke a child workflow by type — runs as Temporal child workflow',
		icon: Workflow,
		color: '#8b5cf6',
		category: 'structure',
		showInPalette: true,
		defaultData: {
			label: 'Child Workflow',
			workflowType: '',
			childInput: '${ . }',
			await: true,
			...EMPTY_FLOW
		}
	}
};

export const NODE_TYPES = Object.keys(NODE_META) as WorkflowNodeType[];

export const CATEGORY_LABELS: Record<string, string> = {
	action: 'Actions',
	control: 'Control Flow',
	event: 'Events',
	structure: 'Structure',
	terminal: 'Terminal'
};
