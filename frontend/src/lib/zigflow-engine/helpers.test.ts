// The small engine modules: header reads, switch-case reading, slugs and scope keys.
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/svelte';
import { parseDocumentHeader, parseInputSchemaFromDsl } from './header';
import {
	caseTargetOptions,
	isDirectiveRouting,
	jumpCasesOf,
	newDirectiveCase,
	newJumpCase,
	switchCasesOf
} from './switchCases';
import { toSlug, toTaskName, uniqueSlug, uniqueTaskName } from './slug';
import {
	ROOT_SCOPE_ID,
	catchScopeKey,
	flowScopeOf,
	forScopeKey,
	forkBranchScopeKey,
	isWorkflowScopeKey,
	tryScopeKey,
	workflowEndNodeId,
	workflowScopeKey,
	workflowStartNodeId
} from './scopeKey';

describe('parseDocumentHeader', () => {
	it('reads taskQueue and workflowType', () => {
		expect(parseDocumentHeader('document:\n  taskQueue: q\n  workflowType: t\n')).toEqual({
			taskQueue: 'q',
			workflowType: 't'
		});
	});

	it.each([
		['empty', ''],
		['blank', '   \n'],
		['invalid YAML', 'document: [unclosed'],
		['a scalar', 'just text'],
		['no document', 'do: []'],
		['document not a map', 'document: 3'],
		['missing taskQueue', 'document:\n  workflowType: t'],
		['empty workflowType', 'document:\n  taskQueue: q\n  workflowType: ""'],
		['non-string taskQueue', 'document:\n  taskQueue: 5\n  workflowType: t']
	])('returns null for %s', (_, dsl) => {
		expect(parseDocumentHeader(dsl)).toBeNull();
	});
});

describe('parseInputSchemaFromDsl', () => {
	it('lists declared input fields', () => {
		const dsl = `input:
  schema:
    format: json
    document:
      type: object
      required: [name]
      properties:
        name:
          type: string
        count:
          type: integer
`;
		const fields = parseInputSchemaFromDsl(dsl);
		expect(fields.map((f) => f.name)).toEqual(['name', 'count']);
		expect(fields.find((f) => f.name === 'name')).toMatchObject({ required: true });
	});

	it.each([
		['empty', ''],
		['invalid YAML', 'input: [x'],
		['a scalar', '42'],
		['no input', 'do: []'],
		['input not a map', 'input: yes']
	])('declares nothing for %s', (_, dsl) => {
		expect(parseInputSchemaFromDsl(dsl)).toEqual([]);
	});
});

const node = (id: string, type: string, data: Record<string, unknown> = {}) =>
	({ id, type, data, position: { x: 0, y: 0 } }) as Node;

describe('switch cases', () => {
	it('fills in missing case fields', () => {
		const sw = node('s', 'switch', {
			cases: [
				{ id: '', routing: undefined },
				{ id: 'c2', name: 'n', condition: 'x', routing: 'task' }
			]
		});
		expect(switchCasesOf(sw)).toEqual([
			{ id: 'case-0', name: '', condition: '', routing: 'continue' },
			{ id: 'c2', name: 'n', condition: 'x', routing: 'task' }
		]);
		expect(jumpCasesOf(sw).map((c) => c.id)).toEqual(['c2']);
	});

	it('reads no cases from nothing', () => {
		expect(switchCasesOf(undefined)).toEqual([]);
		expect(switchCasesOf(node('s', 'switch', { cases: 'nope' }))).toEqual([]);
	});

	it('knows the directive routings', () => {
		expect(['continue', 'exit', 'end'].every((r) => isDirectiveRouting(r as never))).toBe(true);
		expect(isDirectiveRouting('task')).toBe(false);
	});

	it('offers named workflows, and a task a case already names', () => {
		const sw = node('s', 'switch', {
			cases: [{ id: 'c', routing: 'task', targetNodeId: 'task1' }]
		});
		const nodes = [
			node('start', 'start', { label: 'Main' }),
			node('wf-a', 'start', { label: 'approve' }),
			node('wf-b', 'start', {}),
			node('task1', 'set', { label: 'Legacy' }),
			node('task2', 'set', { label: 'Other' }),
			sw
		];
		expect(caseTargetOptions(sw, nodes)).toEqual([
			{ value: 'wf-a', label: 'approve' },
			{ value: 'wf-b', label: 'start' },
			{ value: 'task1', label: 'Legacy (task — not a workflow)' }
		]);
	});

	it('mints fresh cases', () => {
		const jump = newJumpCase('go', 'wf-a', '.x');
		expect(jump).toMatchObject({
			name: 'go',
			targetNodeId: 'wf-a',
			condition: '.x',
			routing: 'task'
		});
		const directive = newDirectiveCase('stop', 'end');
		expect(directive).toMatchObject({ name: 'stop', condition: '', routing: 'end' });
		expect(jump.id).not.toBe(directive.id);
	});
});

describe('slugs and task names', () => {
	it('slugs labels', () => {
		expect(toSlug('Fetch The Order!')).toBe('fetch-the-order');
		expect(toSlug('---')).toBe('task');
		expect(toSlug(undefined as never)).toBe('task');
	});

	it('keeps identifier-shaped names verbatim', () => {
		expect(toTaskName(' processElectronicOrder ')).toBe('processElectronicOrder');
		expect(toTaskName('step.one-2')).toBe('step.one-2');
		expect(toTaskName('Fetch order')).toBe('fetch-order');
		expect(toTaskName(undefined as never)).toBe('task');
	});

	it('deduplicates within a scope', () => {
		const taken = new Set<string>();
		expect(uniqueTaskName('fetchOrder', taken)).toBe('fetchOrder');
		expect(uniqueTaskName('fetchOrder', taken)).toBe('fetchOrder-2');
		expect(uniqueTaskName('fetchOrder', taken)).toBe('fetchOrder-3');
		expect(uniqueSlug('Fetch Order', taken)).toBe('fetch-order');
		expect(uniqueSlug('fetch order', taken)).toBe('fetch-order-2');
	});
});

describe('scope keys', () => {
	it('builds nested body keys from the parent', () => {
		expect(forScopeKey(ROOT_SCOPE_ID, 'loop')).toBe('root/loop/do');
		expect(tryScopeKey('root/loop/do', 't')).toBe('root/loop/do/t/try');
		expect(catchScopeKey(ROOT_SCOPE_ID, 't')).toBe('root/t/catch');
		expect(forkBranchScopeKey(ROOT_SCOPE_ID, 'f', 'b1')).toBe('root/f/branch/b1');
	});

	it('maps named workflow scopes', () => {
		const key = workflowScopeKey('wf1');
		expect(key).toBe('workflow/wf1');
		expect(isWorkflowScopeKey(key)).toBe(true);
		expect(isWorkflowScopeKey(forScopeKey(key, 'loop'))).toBe(false);
		expect(isWorkflowScopeKey('root')).toBe(false);
		expect(workflowStartNodeId(key)).toBe('wf1');
		expect(workflowEndNodeId('wf1')).toBe('wf1--end');
	});

	it('finds the flow a scope belongs to', () => {
		expect(flowScopeOf('root/loop/do')).toBe(ROOT_SCOPE_ID);
		expect(flowScopeOf('workflow/wf1')).toBe('workflow/wf1');
		expect(flowScopeOf('workflow/wf1/loop/do')).toBe('workflow/wf1');
	});
});
