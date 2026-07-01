const KEY = 'duraflow-theme';

export type Theme = 'light' | 'dark';

export function getCurrentTheme(): Theme {
	return (document.documentElement.getAttribute('data-theme') as Theme) || 'light';
}

export function applyTheme(theme: Theme) {
	document.documentElement.setAttribute('data-theme', theme);
	localStorage.setItem(KEY, theme);
}

export function toggleTheme(): Theme {
	const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
	applyTheme(next);
	return next;
}
