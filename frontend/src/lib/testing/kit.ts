// Test-only helpers for calling SvelteKit load functions, actions and request handlers directly,
// without a running server. Nothing outside *.test.ts files imports this.
import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { expect } from 'vitest';

export interface FakeCookies {
	get(name: string): string | undefined;
	set(name: string, value: string, options?: Record<string, unknown>): void;
	delete(name: string, options?: Record<string, unknown>): void;
	/** What set() was last called with, per cookie. */
	written: Map<string, { value: string; options?: Record<string, unknown> }>;
	deleted: string[];
}

export function fakeCookies(initial: Record<string, string> = {}): FakeCookies {
	const jar = new Map(Object.entries(initial));
	const written: FakeCookies['written'] = new Map();
	const deleted: string[] = [];
	return {
		get: (name) => jar.get(name),
		set: (name, value, options) => {
			jar.set(name, value);
			written.set(name, { value, options });
		},
		delete: (name) => {
			jar.delete(name);
			deleted.push(name);
		},
		written,
		deleted
	};
}

/** A POST carrying form fields, as a SvelteKit form action receives it. */
export function formRequest(fields: Record<string, string | string[]> = {}): Request {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
	}
	return new Request('http://app.test/', { method: 'POST', body });
}

/**
 * Builds the event argument for a load/action/handler. Only the fields a test passes exist, so the
 * cast is deliberate: the code under test must not touch anything else.
 */
export function kitEvent(fields: {
	cookies?: FakeCookies;
	request?: Request;
	url?: string;
	params?: Record<string, string>;
	locals?: Record<string, unknown>;
	fetch?: typeof fetch;
}): never {
	return {
		cookies: fields.cookies ?? fakeCookies({ session: 'tok' }),
		request: fields.request ?? formRequest(),
		url: new URL(fields.url ?? 'http://app.test/'),
		params: fields.params ?? {},
		locals: fields.locals ?? {},
		fetch: fields.fetch ?? fetch
	} as never;
}

/** Runs fn and returns what it threw, failing if it didn't. */
async function thrown(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	expect.fail('expected the call to throw');
}

export async function expectRedirect(fn: () => unknown, location: string, status = 303) {
	const err = await thrown(fn);
	expect(isRedirect(err), `expected a redirect, got ${String(err)}`).toBe(true);
	expect(err).toMatchObject({ status, location });
}

export async function expectHttpError(fn: () => unknown, status: number) {
	const err = await thrown(fn);
	expect(isHttpError(err), `expected an HTTP error, got ${String(err)}`).toBe(true);
	expect(err).toMatchObject({ status });
}

/** Asserts an action returned fail(status, data) and gives back its data. */
export function expectFailure(result: unknown, status: number): Record<string, unknown> {
	expect(isActionFailure(result), `expected fail(${status}), got ${JSON.stringify(result)}`).toBe(
		true
	);
	expect(result).toMatchObject({ status });
	return (result as { data: Record<string, unknown> }).data;
}

/** Loads return `void | data`; tests know which. */
export function data<T>(value: T | void): T {
	expect(value).toBeDefined();
	return value as T;
}
