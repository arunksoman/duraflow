#!/usr/bin/env node
// Captures every screenshot the docs use, in both of the app's themes, from a running Duraflow.
//
// It expects the isolated screenshot stack (see compose.screenshots.yml), which has an empty
// database, so nothing from your own dev data ends up in the docs:
//
//   pnpm screenshots:up      # from docs/ — builds and starts the stack on ports 15173/18000
//   pnpm screenshots         # writes public/screenshots/<name>-light.webp and <name>-dark.webp
//   pnpm screenshots:down    # removes the stack and its database
//
// It creates an "Order fulfilment" project (replacing one left by an earlier run), with real
// workflows, runs and workers. Pass --only=<substring> to re-shoot a subset.
//
// Environment: DOCS_APP_URL (default http://localhost:15173), DOCS_API_URL (default
// http://localhost:18000/api), DOCS_ADMIN_EMAIL / DOCS_ADMIN_PASSWORD (default: the seeded admin
// from docker-compose.yml).

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { nodeGallery } from './node-gallery.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'screenshots');

const APP = process.env.DOCS_APP_URL ?? 'http://localhost:15173';
const API = process.env.DOCS_API_URL ?? 'http://localhost:18000/api';
const EMAIL = process.env.DOCS_ADMIN_EMAIL ?? 'admin@duraflow.local';
const PASSWORD = process.env.DOCS_ADMIN_PASSWORD ?? 'changeme123';
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const THEMES = /** @type {const} */ (['light', 'dark']);
const VIEWPORT = { width: 1440, height: 900 };
// Shot at 2x so canvas text stays legible when the image is scaled into a docs page, then stored
// as WebP to keep the repository small.
const SCALE = 2;

// ── Backend API (setup and teardown only — everything shown is driven through the UI) ─────────

let token = '';
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

async function waitForRun(id) {
  for (let i = 0; i < 120; i++) {
    const run = await api('GET', `/executions/${id}`);
    if (run.status !== 'running' && run.status !== 'pending') return run;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`run ${id} never finished`);
}

const dsl = (file) => readFile(join(here, 'workflows', file), 'utf8');

// ── Browser helpers ───────────────────────────────────────────────────────────────────────────

async function shoot(page, name, theme, target) {
  if (only && !name.includes(only)) return;
  // Let transitions, fitView and CodeMirror settle.
  await page.waitForTimeout(600);
  const file = `${name}-${theme}.webp`;
  const png = await (target ?? page).screenshot();
  await sharp(png).webp({ quality: 82 }).toFile(join(outDir, file));
  console.log(`  ✓ ${file}`);
}

const node = (scope, label) =>
  scope.locator('.svelte-flow__node').filter({ hasText: new RegExp(`^\\s*${label}\\b`) }).first();

/** The lane-frame layer sits over the canvas, so dispatch the click rather than aim a pointer. */
async function selectNode(scope, label) {
  await node(scope, label).dispatchEvent('click');
}

async function openBuilder(page, projectId, workflowId) {
  await page.goto(`${APP}/projects/${projectId}/workflows/${workflowId}/builder`);
  await page.locator('.svelte-flow__node').first().waitFor();
}

async function loadDsl(page, text) {
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  const editor = page.locator('.modal .cm-content');
  await editor.fill(text);
  // Sync to canvas is debounced.
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '✕' }).click();
  await page.waitForTimeout(400);
}

// ── Scenes ────────────────────────────────────────────────────────────────────────────────────

async function captureTheme(browser, theme, fx) {
  console.log(`\n${theme} theme`);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: theme,
    storageState: fx.storageState,
  });
  await context.addInitScript((t) => localStorage.setItem('duraflow-theme', t), theme);
  const page = await context.newPage();

  // Login (a fresh context without the session cookie).
  {
    const anon = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: theme,
    });
    await anon.addInitScript((t) => localStorage.setItem('duraflow-theme', t), theme);
    const p = await anon.newPage();
    await p.goto(`${APP}/login`);
    await p.getByPlaceholder('you@company.com').fill(EMAIL);
    await shoot(p, 'login', theme);
    await anon.close();
  }

  await page.goto(`${APP}/dashboard`);
  await page.getByText(fx.projectName).first().waitFor();
  await shoot(page, 'dashboard', theme);

  await page.goto(`${APP}/projects/${fx.projectId}`);
  await page.getByText('Route order').first().waitFor();
  await shoot(page, 'project', theme);

  // Builder: the showcase workflow, untouched.
  await openBuilder(page, fx.projectId, fx.orders.id);
  await shoot(page, 'builder-overview', theme);

  await selectNode(page, 'eachOrder');
  await shoot(page, 'builder-node-panel', theme);
  await page.getByRole('button', { name: 'Close panel' }).click();

  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await page.locator('.modal .cm-content').waitFor();
  await shoot(page, 'builder-dsl', theme);
  await page.getByRole('button', { name: '✕' }).click();

  await page.getByRole('button', { name: 'Variables' }).click();
  await shoot(page, 'builder-variables', theme);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('.svelte-flow__node').first().waitFor();

  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByRole('checkbox', { name: 'Run on a schedule' }).check();
  await shoot(page, 'builder-schedule', theme);
  await page.reload();
  await page.locator('.svelte-flow__node').first().waitFor();

  // Run it from the builder: inputs dialog, then the live run window.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const runWindow = page.getByRole('dialog', { name: 'Run Process orders' });
  await runWindow.waitFor();
  // A workflow with declared inputs opens its inputs dialog straight away.
  const inputs = page.getByRole('dialog', { name: 'Run inputs' });
  await inputs.waitFor();
  await inputs.getByRole('tab', { name: 'JSON', exact: true }).click();
  await inputs.locator('.cm-content').fill('{ "orderIds": [101, 102, 103], "priority": "standard" }');
  await shoot(page, 'run-inputs', theme);
  await inputs.getByRole('button', { name: 'Run', exact: true }).click();
  await runWindow.getByText('completed', { exact: true }).waitFor({ timeout: 120_000 });
  await shoot(page, 'run-window', theme);
  await selectNode(runWindow, 'summarise');
  await shoot(page, 'run-inspector', theme);
  await runWindow.getByRole('button', { name: 'Close run window' }).click();

  // Named workflows and switch cases.
  await openBuilder(page, fx.projectId, fx.routing.id);
  await shoot(page, 'builder-named-workflows', theme);

  // A replayed run, on its own page.
  await page.goto(`${APP}/executions/${fx.routingRun}`);
  await node(page, 'classify').waitFor();
  await shoot(page, 'execution-switch', theme);

  await page.goto(`${APP}/executions/${fx.ordersRun}`);
  await node(page, 'charge').waitFor();
  await shoot(page, 'execution-detail', theme);
  await selectNode(page, 'capturePayment');
  await shoot(page, 'execution-error', theme);

  await page.goto(`${APP}/executions`);
  await page.getByRole('row', { name: /Process orders/ }).first().waitFor();
  await shoot(page, 'executions', theme);

  await page.goto(`${APP}/workers`);
  await page.getByRole('row', { name: /Process orders/ }).first().waitFor();
  await shoot(page, 'workers', theme);

  // One builder shot per node type, from a draft workflow that is never saved.
  for (const item of nodeGallery) {
    if (only && !item.name.includes(only)) continue;
    await openBuilder(page, fx.projectId, fx.gallery.id);
    await loadDsl(page, item.dsl);
    await selectNode(page, item.click);
    // The panel narrows the canvas; re-fit so nested bodies stay in frame, and hide the minimap,
    // which would otherwise sit on top of them in such a small workflow.
    await page.waitForTimeout(300);
    await page.locator('.svelte-flow__controls-fitview').click();
    await page.addStyleTag({ content: '.svelte-flow__minimap { display: none; }' });
    await page.waitForTimeout(300);
    await shoot(page, item.name, theme);
  }

  await context.close();
}

async function main() {
  await mkdir(outDir, { recursive: true });

  token = (await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD })).token;
  const projectName = 'Order fulfilment';
  for (const old of await api('GET', '/projects')) {
    if (old.name === projectName) await api('DELETE', `/projects/${old.id}`);
  }
  const project = await api('POST', '/projects', {
    name: projectName,
    description: 'Order handling workflows',
  });

  {
    const orders = await api('POST', `/projects/${project.id}/workflows`, {
      name: 'Process orders',
      description: 'Reserve stock, notify the customer and take payment',
      dsl: await dsl('process-orders.yaml'),
    });
    const routing = await api('POST', `/projects/${project.id}/workflows`, {
      name: 'Route order',
      description: 'Send each order to the workflow that handles its type',
      dsl: await dsl('route-order.yaml'),
    });
    const gallery = await api('POST', `/projects/${project.id}/workflows`, {
      name: 'Node gallery',
      description: 'A scratch workflow',
    });

    // Real runs, so the executions list, run pages and Workers page have something to show.
    const ordersRun = await api('POST', `/workflows/${orders.id}/executions`, {
      input: { orderIds: [101, 102, 103], priority: 'standard' },
    });
    const routingRun = await api('POST', `/workflows/${routing.id}/executions`, {
      input: { orderType: 'electronic' },
    });
    console.log('waiting for seed runs…');
    console.log(' ', (await waitForRun(ordersRun.id)).status, 'process-orders');
    console.log(' ', (await waitForRun(routingRun.id)).status, 'route-order');

    const browser = await chromium.launch();
    try {
      // Log in once through the UI and share the session cookie across both themes.
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto(`${APP}/login`);
      await p.getByPlaceholder('you@company.com').fill(EMAIL);
      await p.getByPlaceholder('••••••••').fill(PASSWORD);
      await p.getByRole('button', { name: 'Log in' }).click();
      await p.waitForURL(/\/dashboard/);
      const storageState = await ctx.storageState();
      await ctx.close();

      const fx = {
        storageState,
        projectId: project.id,
        projectName,
        orders,
        routing,
        gallery,
        ordersRun: ordersRun.id,
        routingRun: routingRun.id,
      };
      for (const theme of THEMES) await captureTheme(browser, theme, fx);
    } finally {
      await browser.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
