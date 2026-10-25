import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the whole running stack — Temporal, the Go backend (whose worker pool
 * runs workflows through zigflow) and this app — as `docker compose up` starts it from the repo root.
 * Nothing here starts a server: bring the stack up first, then `pnpm test:e2e`.
 *
 * Point at another deployment with E2E_BASE_URL; the seeded admin's credentials come from
 * E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (defaults match docker-compose.yml).
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const ci = !!process.env.CI;

export default defineConfig({
	testDir: './e2e',
	outputDir: './test-results/e2e',
	// The specs share one backend and one admin; running them side by side buys little and makes
	// failures harder to read.
	fullyParallel: false,
	workers: 1,
	forbidOnly: ci,
	retries: ci ? 1 : 0,
	// A run waits on the worker pool picking up a new task queue and on Temporal, so allow for a
	// slow first start.
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: [
		['list'],
		['html', { outputFolder: './playwright-report', open: 'never' }],
		['junit', { outputFile: './test-results/e2e-junit.xml' }]
	],
	use: {
		baseURL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	projects: [
		{ name: 'setup', testMatch: /auth\.setup\.ts/ },
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/admin.json' },
			dependencies: ['setup']
		}
	]
});
