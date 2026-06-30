import type { Component } from 'svelte';
import {
	Bell,
	CheckSquare,
	Clock,
	GitBranch,
	GitFork,
	Globe,
	ListChecks,
	Pencil,
	Repeat,
	ShieldAlert,
	Terminal,
	Workflow,
	Zap
} from '@lucide/svelte';
import type { WorkflowNodeType } from '$lib/types';

export interface NodeMeta {
	label: string;
	description: string;
	icon: Component<{ size?: number; class?: string }>;
	color: string;
	category: 'action' | 'control' | 'event' | 'structure';
	defaultData: Record<string, unknown>;
}

export const NODE_META: Record<WorkflowNodeType, NodeMeta> = {
	task: {
		label: 'Task',
		description: 'Execute a named task',
		icon: CheckSquare,
		color: '#3b82f6',
		category: 'action',
		defaultData: { label: 'Task', timeout: '30s' }
	},
	call: {
		label: 'Call',
		description: 'HTTP or function call',
		icon: Globe,
		color: '#6366f1',
		category: 'action',
		defaultData: { label: 'Call', method: 'get', endpoint: 'https://api.example.com/endpoint' }
	},
	do: {
		label: 'Do',
		description: 'Sequential steps',
		icon: ListChecks,
		color: '#64748b',
		category: 'control',
		defaultData: { label: 'Do' }
	},
	for: {
		label: 'For',
		description: 'Iterate over items',
		icon: Repeat,
		color: '#14b8a6',
		category: 'control',
		defaultData: { label: 'For Each', each: 'item', collection: 'items' }
	},
	fork: {
		label: 'Fork',
		description: 'Parallel branches',
		icon: GitFork,
		color: '#f97316',
		category: 'control',
		defaultData: { label: 'Fork' }
	},
	listen: {
		label: 'Listen',
		description: 'Wait for an event',
		icon: Bell,
		color: '#a855f7',
		category: 'event',
		defaultData: { label: 'Listen', eventType: 'custom.event' }
	},
	raise: {
		label: 'Raise',
		description: 'Emit an event',
		icon: Zap,
		color: '#eab308',
		category: 'event',
		defaultData: { label: 'Raise', eventType: 'custom.event' }
	},
	run: {
		label: 'Run',
		description: 'Run a subprocess',
		icon: Terminal,
		color: '#6b7280',
		category: 'action',
		defaultData: { label: 'Run', taskName: 'my-task' }
	},
	set: {
		label: 'Set',
		description: 'Set a variable',
		icon: Pencil,
		color: '#10b981',
		category: 'action',
		defaultData: { label: 'Set', variable: 'result', value: 'output' }
	},
	switch: {
		label: 'Switch',
		description: 'Conditional branch',
		icon: GitBranch,
		color: '#06b6d4',
		category: 'control',
		defaultData: { label: 'Switch' }
	},
	try: {
		label: 'Try',
		description: 'Error handling',
		icon: ShieldAlert,
		color: '#ef4444',
		category: 'control',
		defaultData: { label: 'Try' }
	},
	wait: {
		label: 'Wait',
		description: 'Wait or sleep',
		icon: Clock,
		color: '#f59e0b',
		category: 'event',
		defaultData: { label: 'Wait', duration: 30 }
	},
	childWorkflow: {
		label: 'Child Flow',
		description: 'Nested workflow',
		icon: Workflow,
		color: '#8b5cf6',
		category: 'structure',
		defaultData: { label: 'Child Workflow', workflowName: 'child-workflow' }
	}
};

export const NODE_TYPES = Object.keys(NODE_META) as WorkflowNodeType[];

export const CATEGORY_LABELS: Record<string, string> = {
	action: 'Actions',
	control: 'Control Flow',
	event: 'Events',
	structure: 'Structure'
};
