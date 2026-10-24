// Post-processes the static export in out/ for GitHub Pages.
//
// 1. Next writes each route's prefetch segments as nested files
//    (`__next.docs/$oc$slug/__PAGE__.txt`) but the client router requests them by a flat, dotted
//    name (`__next.docs.$oc$slug.__PAGE__.txt`). A static host has no rewrite to bridge that, so
//    every prefetch would 404 and client navigation would fall back to full page loads. Writing a
//    flat copy next to each nested file fixes it.
// 2. `.nojekyll`, so Pages serves the `_next/` folder as-is if the site is ever published from a
//    branch rather than by the Actions workflow.

import { copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

let copied = 0;
for await (const file of walk(out)) {
  const rel = relative(out, file).split(sep);
  // The first `__next.*` directory in the path starts a nested segment file.
  const at = rel.findIndex((part, i) => part.startsWith('__next.') && i < rel.length - 1);
  if (at < 0) continue;
  const flat = join(out, ...rel.slice(0, at), rel.slice(at).join('.'));
  const exists = await stat(flat).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await copyFile(file, flat);
    copied++;
  }
}

await writeFile(join(out, '.nojekyll'), '');
console.log(`postbuild: wrote ${copied} flat prefetch segment files and .nojekyll`);
