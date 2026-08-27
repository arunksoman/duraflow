<script lang="ts">
	import { untrack } from 'svelte';
	import { EditorView, basicSetup } from 'codemirror';
	import { EditorState, Compartment } from '@codemirror/state';
	import { StreamLanguage, type StreamParser } from '@codemirror/language';
	import { yaml } from '@codemirror/lang-yaml';
	import { json } from '@codemirror/lang-json';
	import { javascript } from '@codemirror/lang-javascript';
	import { python } from '@codemirror/lang-python';
	import { shell } from '@codemirror/legacy-modes/mode/shell';
	import { vscodeLight, vscodeDark } from '@uiw/codemirror-theme-vscode';
	import { linter, type Diagnostic } from '@codemirror/lint';
	import type { Extension } from '@codemirror/state';
	import { getCurrentTheme } from '$lib/utils/theme.svelte';

	export type EditorLanguage = 'yaml' | 'json' | 'javascript' | 'python' | 'shell';

	interface Props {
		value: string;
		language: EditorLanguage;
		readOnly?: boolean;
		onchange?: (value: string) => void;
		diagnostics?: Diagnostic[];
	}

	let {
		value = $bindable(''),
		language,
		readOnly = false,
		onchange,
		diagnostics = []
	}: Props = $props();

	let view: EditorView | undefined;
	/**
	 * The last doc text we ourselves pushed out via `onchange`. Distinguishes a genuinely
	 * external `value` change (e.g. the parent reset the draft, or switched to a different
	 * node's code) from the parent simply echoing back what we just typed one render later —
	 * without this, a slow/batched echo can race ahead of fast typing and clobber newer
	 * keystrokes with stale content.
	 */
	let lastEmitted = value;

	const languageCompartment = new Compartment();
	const themeCompartment = new Compartment();
	const readOnlyCompartment = new Compartment();
	const lintCompartment = new Compartment();

	function languageExtension(lang: EditorLanguage): Extension {
		if (lang === 'yaml') return yaml();
		if (lang === 'json') return json();
		if (lang === 'javascript') return javascript();
		if (lang === 'python') return python();
		return StreamLanguage.define(shell as StreamParser<unknown>);
	}

	function themeExtension(): Extension {
		return getCurrentTheme() === 'dark' ? vscodeDark : vscodeLight;
	}

	function mountEditor(node: HTMLDivElement) {
		// `{@attach}` re-runs (tearing down and recreating the whole editor, losing focus/cursor)
		// whenever a reactive value read *synchronously in this function body* changes — so every
		// prop used to build the initial state must be read via `untrack()`. Subsequent changes to
		// those same props are applied via the `$effect`s below instead, which reconfigure the
		// existing view in place rather than rebuilding it.
		const initial = untrack(() => ({ value, language, readOnly }));
		const initialTheme = untrack(() => themeExtension());
		const state = EditorState.create({
			doc: initial.value,
			extensions: [
				basicSetup,
				languageCompartment.of(languageExtension(initial.language)),
				themeCompartment.of(initialTheme),
				readOnlyCompartment.of(EditorState.readOnly.of(initial.readOnly)),
				lintCompartment.of(linter(() => diagnostics)),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						value = update.state.doc.toString();
						lastEmitted = value;
						onchange?.(value);
					}
				})
			]
		});
		view = new EditorView({ state, parent: node });
		return () => {
			view?.destroy();
			view = undefined;
		};
	}

	// The functions below feed CodeMirror's own imperative `view.dispatch(...)` API — they don't
	// reassign Svelte state, so driving them from `$effect` (rather than `$derived`) is correct here.
	$effect(() => {
		const ext = languageExtension(language);
		view?.dispatch({ effects: languageCompartment.reconfigure(ext) });
	});

	$effect(() => {
		const ext = themeExtension();
		view?.dispatch({ effects: themeCompartment.reconfigure(ext) });
	});

	$effect(() => {
		view?.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
	});

	$effect(() => {
		const d = diagnostics;
		view?.dispatch({ effects: lintCompartment.reconfigure(linter(() => d)) });
	});

	// Reflect external `value` changes (e.g. loading a different node's code, or a DSL reload)
	// into the editor without recreating it. Skip anything that's just an echo of our own last
	// emission — including a stale/batched one arriving after further keystrokes — so we never
	// fight the user's own typing.
	$effect(() => {
		if (!view) return;
		if (value === lastEmitted) return;
		const current = view.state.doc.toString();
		if (value !== current) {
			view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
			lastEmitted = value;
		}
	});
</script>

<div class="cm-editor-host h-full w-full overflow-hidden" {@attach mountEditor}></div>

<style>
	.cm-editor-host :global(.cm-editor) {
		height: 100%;
		font-size: 12px;
	}
	.cm-editor-host :global(.cm-scroller) {
		font-family:
			ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
			monospace;
	}
</style>
