import { describe, expect, it } from 'vitest';
import { toSlug, toTaskName, uniqueSlug } from './slug';

describe('toTaskName', () => {
	it('keeps labels that are already valid task names', () => {
		expect(toTaskName('fetchProfile')).toBe('fetchProfile');
		expect(toTaskName('set-user')).toBe('set-user');
		expect(toTaskName('step_1')).toBe('step_1');
	});

	it('camelCases free-form labels', () => {
		expect(toTaskName('Set Variables')).toBe('setVariables');
		expect(toTaskName('REST Call')).toBe('restCall');
		expect(toTaskName('  ')).toBe('task');
		expect(toTaskName('2 step')).toBe('task2Step');
	});

	it('suffixes duplicates within a scope', () => {
		const taken = new Set<string>();
		expect(uniqueSlug('Set Variables', taken)).toBe('setVariables');
		expect(uniqueSlug('Set Variables', taken)).toBe('setVariables2');
	});

	it('leaves the RFC 1123 slug used for workflowType/taskQueue alone', () => {
		expect(toSlug('My Workflow')).toBe('my-workflow');
	});
});
