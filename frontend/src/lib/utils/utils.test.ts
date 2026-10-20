import { describe, expect, it } from 'vitest';
import { tintFor } from './tint';
import { RUN_TONE_VAR, runTone } from '$lib/components/builder/runStatus';

describe('tintFor', () => {
	it('is stable per key and uses full class strings', () => {
		expect(tintFor('orders')).toBe(tintFor('orders'));
		expect(tintFor('')).toMatch(/^bg-\S+ text-\S+$/);
		const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'billing', 'ops'].map(tintFor));
		expect(seen.size).toBeGreaterThan(1);
	});
});

describe('runTone', () => {
	it.each([
		['success', 'success'],
		['running', 'running'],
		['error', 'error'],
		['skipped', 'continued'],
		['pending', 'neutral'],
		['unknown', 'neutral'],
		[undefined, 'neutral']
	] as const)('%s -> %s', (state, tone) => {
		expect(runTone(state as never)).toBe(tone);
		expect(RUN_TONE_VAR[tone]).toMatch(/^var\(--run-/);
	});
});
