const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * 24 * 60 * 60],
	['month', 30 * 24 * 60 * 60],
	['week', 7 * 24 * 60 * 60],
	['day', 24 * 60 * 60],
	['hour', 60 * 60],
	['minute', 60]
];

const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago" — for timestamps shown at a glance. */
export function relativeTime(iso: string, now: number = Date.now()): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';
	const seconds = Math.round((then - now) / 1000);
	for (const [unit, size] of UNITS) {
		if (Math.abs(seconds) >= size) return formatter.format(Math.trunc(seconds / size), unit);
	}
	return 'just now';
}
