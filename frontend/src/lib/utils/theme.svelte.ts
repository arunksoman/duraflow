const KEY = 'duraflow-theme';

export type Theme = 'light' | 'dark';

function readDomTheme(): Theme {
	if (typeof document === 'undefined') return 'light';
	return (document.documentElement.getAttribute('data-theme') as Theme) || 'light';
}

/** Reactive current theme — read this (not the DOM) from anywhere that needs to react live to theme changes (e.g. CodeMirrorEditor's Compartment swap). */
let theme = $state<Theme>(readDomTheme());

export function getCurrentTheme(): Theme {
	return theme;
}

export function applyTheme(next: Theme) {
	theme = next;
	document.documentElement.setAttribute('data-theme', next);
	localStorage.setItem(KEY, next);
}

export function toggleTheme(): Theme {
	const next = theme === 'dark' ? 'light' : 'dark';
	applyTheme(next);
	return next;
}
