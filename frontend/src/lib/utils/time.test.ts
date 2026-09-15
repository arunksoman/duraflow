import { describe, expect, it } from 'vitest';
import { relativeTime } from './time';

const NOW = new Date('2026-09-15T12:00:00Z').getTime();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('relativeTime', () => {
	it('says "just now" under a minute', () => {
		expect(relativeTime(ago(30), NOW)).toBe('just now');
	});

	it('picks the largest whole unit', () => {
		expect(relativeTime(ago(5 * 60), NOW)).toBe('5 minutes ago');
		expect(relativeTime(ago(3 * 3600), NOW)).toBe('3 hours ago');
		expect(relativeTime(ago(24 * 3600), NOW)).toBe('yesterday');
		expect(relativeTime(ago(16 * 24 * 3600), NOW)).toBe('2 weeks ago');
		expect(relativeTime(ago(400 * 24 * 3600), NOW)).toBe('last year');
	});

	it('returns an empty string for an unparseable date', () => {
		expect(relativeTime('not a date', NOW)).toBe('');
	});
});
