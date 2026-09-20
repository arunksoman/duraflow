import { describe, it, expect } from 'vitest';
import { astToGraph } from './graph';
import type { ZigflowDocument } from './ast';
import { buildRunIndex, scopeNameKey } from './runIndex';
import { resolveNode, resolveScopePath, describeScopePath } from './runScope';
import { ROOT_SCOPE_ID, forScopeKey, tryScopeKey, workflowScopeKey } from './scopeKey';

function header() {
	return { dsl: '1.0.0', taskQueue: 'zigflow', workflowType: 'example', version: '0.1.0' };
}

function httpTask(endpoint = 'https://example.com') {
	return { call: 'http' as const, with: { method: 'get', endpoint } };
}

/** Builds the index the same way the app does: straight off a graph loaded from a DSL. */
function indexFor(doc: ZigflowDocument) {
	const { graph } = astToGraph(doc);
	return { index: buildRunIndex(graph), graph };
}

describe('buildRunIndex', () => {
	it('keeps identically-named tasks in different scopes apart', () => {
		const { index, graph } = indexFor({
			document: header(),
			do: [
				{ fetch: httpTask() },
				{
					loop: {
						for: { each: 'item', in: '${ $input.items }' },
						do: [{ fetch: httpTask('https://inner.example.com') }]
					}
				}
			]
		});

		const rootFetch = index.byScopeAndName.get(scopeNameKey(ROOT_SCOPE_ID, 'fetch'));
		const loopNodeId = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'for')!.id;
		const innerScope = forScopeKey(ROOT_SCOPE_ID, loopNodeId);
		const innerFetch = index.byScopeAndName.get(scopeNameKey(innerScope, 'fetch'));

		expect(rootFetch).toBeTruthy();
		expect(innerFetch).toBeTruthy();
		expect(rootFetch).not.toBe(innerFetch);
		// Both are still reachable by name alone, which is what makes the fallback ambiguous.
		expect(index.nodeIdsByName.get('fetch')).toHaveLength(2);
	});

	it('records a nested `do` as an inline scope and a `for` as a child workflow scope', () => {
		// The `do:` group has to be nested: at the root, a `do:` task is a whole separate workflow.
		const { index } = indexFor({
			document: header(),
			do: [
				{
					loop: {
						for: { each: 'i', in: '${ [1] }' },
						do: [{ group: { do: [{ inner: httpTask() }] } }, { looped: httpTask() }]
					}
				}
			]
		});

		const loopScope = index.childScopesByParent.get(ROOT_SCOPE_ID)!.find((c) => c.kind === 'for')!;
		expect(loopScope.inline).toBe(false);
		const inner = index.childScopesByParent.get(loopScope.childScopeId) ?? [];
		expect(inner.find((c) => c.kind === 'do')?.inline).toBe(true);
	});

	it('indexes a named workflow as its own root, never as a child scope of the primary one', () => {
		const { index, graph } = indexFor({
			document: header(),
			do: [{ fetch: httpTask() }, { handler: { do: [{ inner: httpTask() }] } }]
		});

		// nothing can resolve a scope path into it — it is a separate Temporal workflow
		expect(index.childScopesByParent.get(ROOT_SCOPE_ID)).toBeUndefined();

		const handler = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'workflow')!;
		const innerId = index.byScopeAndName.get(scopeNameKey(workflowScopeKey(handler.id), 'inner'));
		expect(innerId).toBeTruthy();
	});

	it('flags a scope whose two `for` tasks zigflow cannot tell apart', () => {
		const { index } = indexFor({
			document: header(),
			do: [
				{ first: { for: { each: 'i', in: '${ [1] }' }, do: [{ a: httpTask() }] } },
				{ second: { for: { each: 'i', in: '${ [2] }' }, do: [{ b: httpTask() }] } }
			]
		});

		expect(index.ambiguousScopes.has(ROOT_SCOPE_ID)).toBe(true);
	});

	it('covers every scope reachable from the root, including try and catch bodies', () => {
		const { index, graph } = indexFor({
			document: header(),
			do: [
				{
					guarded: {
						try: [{ risky: httpTask() }],
						catch: { as: 'error', do: [{ recover: httpTask() }] }
					}
				}
			]
		});

		const tryNodeId = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'try')!.id;
		expect(
			index.byScopeAndName.get(scopeNameKey(tryScopeKey(ROOT_SCOPE_ID, tryNodeId), 'risky'))
		).toBeTruthy();
		expect(index.allNodeIds.length).toBe(3); // try + risky + recover
	});
});

describe('resolveScopePath', () => {
	it('walks a nested path through a for body into its try body', () => {
		const { index, graph } = indexFor({
			document: header(),
			do: [
				{
					loop: {
						for: { each: 'i', in: '${ [1] }' },
						do: [
							{
								guarded: {
									try: [{ risky: httpTask() }],
									catch: { as: 'error', do: [{ recover: httpTask() }] }
								}
							}
						]
					}
				}
			]
		});

		const loopNodeId = graph.scopes[ROOT_SCOPE_ID].nodes.find((n) => n.type === 'for')!.id;
		const loopScope = forScopeKey(ROOT_SCOPE_ID, loopNodeId);
		const tryNodeId = graph.scopes[loopScope].nodes.find((n) => n.type === 'try')!.id;

		expect(resolveScopePath(index, 'for_0_try')).toEqual({
			scopeId: tryScopeKey(loopScope, tryNodeId),
			ambiguous: false
		});
	});

	it('matches a fork branch by the key zigflow puts in the child workflow id', () => {
		const { index } = indexFor({
			document: header(),
			do: [
				{
					split: {
						fork: {
							branches: [
								{ 'send-email': { do: [{ email: httpTask() }] } },
								{ other: { do: [{ sms: httpTask() }] } }
							]
						}
					}
				}
			]
		});

		const resolved = resolveScopePath(index, 'fork_send-email');
		expect(resolved.scopeId).toBeTruthy();
		expect(index.byScopeAndName.get(scopeNameKey(resolved.scopeId!, 'email'))).toBeTruthy();
	});

	it('refuses to guess when the path segment is not recognised', () => {
		const { index } = indexFor({ document: header(), do: [{ fetch: httpTask() }] });
		expect(resolveScopePath(index, 'nonsense').scopeId).toBeNull();
	});
});

describe('resolveNode', () => {
	it('finds a task inside an inline `do` block reported at the parent scope path', () => {
		const { index } = indexFor({
			document: header(),
			do: [
				{
					loop: {
						for: { each: 'i', in: '${ [1] }' },
						do: [{ group: { do: [{ inner: httpTask() }] } }]
					}
				}
			]
		});

		const match = resolveNode(index, 'for_0', 'inner');
		expect(match.confidence).toBe('exact');
		expect(match.nodeId).toBeTruthy();
	});

	it('falls back to a unique name when the scope path is unusable', () => {
		const { index } = indexFor({
			document: header(),
			do: [{ loop: { for: { each: 'i', in: '${ [1] }' }, do: [{ deep: httpTask() }] } }]
		});

		const match = resolveNode(index, 'switch-redirect-nonsense', 'deep');
		expect(match.confidence).toBe('name-only');
		expect(match.nodeId).toBeTruthy();
	});

	it('reports no match rather than picking one of two identically-named nodes', () => {
		const { index } = indexFor({
			document: header(),
			do: [
				{ fetch: httpTask() },
				{ loop: { for: { each: 'i', in: '${ [1] }' }, do: [{ fetch: httpTask() }] } }
			]
		});

		expect(resolveNode(index, 'bogus', 'fetch').confidence).toBe('none');
	});
});

describe('describeScopePath', () => {
	it('renders a readable trail', () => {
		expect(describeScopePath('')).toBe('root');
		expect(describeScopePath('for_2_try')).toBe('root → for[2] → try');
		expect(describeScopePath('fork_send_email')).toBe('root → fork:send_email');
	});
});
