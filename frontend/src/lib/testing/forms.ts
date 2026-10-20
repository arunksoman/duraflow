// Test double for `$app/forms`. Use with `vi.mock('$app/forms', () => import('$lib/testing/forms'))`.
//
// `enhance` intercepts the submit, records what would have been posted, then runs the page's own
// submit callback and the callback it returns with whatever result `respondWith` set — so a test
// can drive a page's success and failure handling without a server.
import type { ActionResult, SubmitFunction } from '@sveltejs/kit';

export interface Submission {
	action: string;
	data: FormData;
}

export const submissions: Submission[] = [];

let nextResult: ActionResult = { type: 'success', status: 200 };

export function respondWith(result: ActionResult) {
	nextResult = result;
}

export function resetForms() {
	submissions.length = 0;
	nextResult = { type: 'success', status: 200 };
}

/** Lets a test wait for a submission's callbacks to finish. */
let pending: Promise<void> = Promise.resolve();
export function settled() {
	return pending;
}

export function enhance(form: HTMLFormElement, submit?: SubmitFunction) {
	async function run(event: SubmitEvent) {
		const formData = new FormData(form, event.submitter);
		const action = new URL(form.getAttribute('action') ?? '', location.href);
		let cancelled = false;
		const after = await submit?.({
			action,
			formData,
			formElement: form,
			controller: new AbortController(),
			submitter: event.submitter,
			cancel: () => {
				cancelled = true;
			}
		});
		if (cancelled) return;
		// Recorded after the page's own callback, which may still add to or cancel the submission.
		submissions.push({ action: form.getAttribute('action') ?? '', data: formData });
		if (typeof after !== 'function') return;
		await after({
			action,
			formData,
			formElement: form,
			result: nextResult,
			update: async () => {}
		});
	}

	function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		pending = run(event);
	}

	form.addEventListener('submit', onSubmit);
	return {
		destroy() {
			form.removeEventListener('submit', onSubmit);
		}
	};
}

export async function applyAction() {}
export function deserialize(text: string) {
	return JSON.parse(text);
}
