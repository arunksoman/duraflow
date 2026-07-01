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
	Workflow,
	Zap
} from '@lucide/svelte';
import type { WorkflowNodeType } from '$lib/types';

export interface VarEntry {
	key: string;
	value: string;
}

export interface CaseEntry {
	name: string;
	condition: string;
	then: string;
}

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
		description: 'Workflow entry point — optionally initialise variables',
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
	task: {
		label: 'Task',
		description: 'Execute a named task via HTTP',
		icon: CheckSquare,
		color: '#3b82f6',
		category: 'action',
		showInPalette: true,
		defaultData: { label: 'Task', method: 'get', endpoint: 'https://api.example.com/endpoint', timeout: '30s' }
	},
	call: {
		label: 'REST',
		description: 'REST API call with headers, body, and query params',
		icon: Globe,
		color: '#6366f1',
		category: 'action',
		showInPalette: true,
		defaultData: {
			label: 'REST Call',
			method: 'get',
			endpoint: '',
			headers: [],
			query: [],
			body: '',
			output: 'content',
			redirect: false
		}
	},
	do: {
		label: 'Do',
		description: 'Sequential steps (internal)',
		icon: CheckSquare,
		color: '#64748b',
		category: 'control',
		showInPalette: false,
		defaultData: { label: 'Do' }
	},
	for: {
		label: 'For',
		description: 'Iterate over a collection',
		icon: Repeat,
		color: '#14b8a6',
		category: 'control',
		showInPalette: true,
		defaultData: { label: 'For Each', each: 'item', collection: 'items' }
	},
	fork: {
		label: 'Fork',
		description: 'Parallel branches',
		icon: GitFork,
		color: '#f97316',
		category: 'control',
		showInPalette: true,
		defaultData: { label: 'Fork' }
	},
	listen: {
		label: 'Listen',
		description: 'Wait for an event',
		icon: Bell,
		color: '#a855f7',
		category: 'event',
		showInPalette: true,
		defaultData: { label: 'Listen', eventType: 'custom.event' }
	},
	raise: {
		label: 'Raise',
		description: 'Emit an event',
		icon: Zap,
		color: '#eab308',
		category: 'event',
		showInPalette: true,
		defaultData: { label: 'Raise', eventType: 'custom.event' }
	},
	run: {
		label: 'BYOC',
		description: 'Bring Your Own Code — script, shell, or container',
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
			workflowType: ''
		}
	},
	set: {
		label: 'Set',
		description: 'Set one or more workflow variables',
		icon: Pencil,
		color: '#10b981',
		category: 'action',
		showInPalette: true,
		defaultData: {
			label: 'Set Variables',
			variables: [{ key: 'result', value: '${ . }' }] as VarEntry[]
		}
	},
	switch: {
		label: 'Switch',
		description: 'Conditional branching on runtime expressions',
		icon: GitBranch,
		color: '#06b6d4',
		category: 'control',
		showInPalette: true,
		defaultData: {
			label: 'Switch',
			cases: [
				{ name: 'success', condition: "${ .status == 'success' }", then: 'continue' },
				{ name: 'default', condition: '', then: 'end' }
			] as CaseEntry[]
		}
	},
	try: {
		label: 'Try',
		description: 'Error handling block',
		icon: ShieldAlert,
		color: '#ef4444',
		category: 'control',
		showInPalette: true,
		defaultData: { label: 'Try' }
	},
	wait: {
		label: 'Wait',
		description: 'Pause for a duration',
		icon: Clock,
		color: '#f59e0b',
		category: 'event',
		showInPalette: true,
		defaultData: { label: 'Wait', duration: 30 }
	},
	childWorkflow: {
		label: 'Child Flow',
		description: 'Invoke a nested workflow',
		icon: Workflow,
		color: '#8b5cf6',
		category: 'structure',
		showInPalette: true,
		defaultData: { label: 'Child Workflow', workflowType: 'child-workflow-type' }
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
