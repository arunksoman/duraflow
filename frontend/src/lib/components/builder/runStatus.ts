import type { NodeRunState } from '$lib/zigflow-engine/runState';

/**
 * The colour a node or edge shows for a run. `partial` (some of the work succeeded) and
 * `continued` (a failure the workflow carried on past) are reserved — the run reducer doesn't
 * produce them yet — but they have a colour so they can be wired in without a redesign.
 */
export type RunTone = 'neutral' | 'success' | 'partial' | 'running' | 'continued' | 'error';

/** CSS custom property holding each tone's colour — defined in `src/routes/layout.css`. */
export const RUN_TONE_VAR: Record<RunTone, string> = {
	neutral: 'var(--run-neutral)',
	success: 'var(--run-success)',
	partial: 'var(--run-partial)',
	running: 'var(--run-running)',
	continued: 'var(--run-continued)',
	error: 'var(--run-error)'
};

/**
 * Nodes the run never reached (the path not taken) read as `continued`/amber, so they stand out
 * from both the untouched design and the in-progress blue. `unknown` — the run ended before the
 * task reported back — stays neutral and is labelled on the node instead.
 */
export function runTone(state: NodeRunState | undefined): RunTone {
	switch (state) {
		case 'success':
			return 'success';
		case 'running':
			return 'running';
		case 'error':
			return 'error';
		case 'skipped':
			return 'continued';
		default:
			return 'neutral';
	}
}
