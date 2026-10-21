import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// GitHub Pages serves a project site under /<repo>. The deploy workflow passes that prefix in;
// locally it is empty, so `pnpm dev` serves from the root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  // `/docs/foo/` -> `docs/foo/index.html`, which GitHub Pages resolves without a redirect dance.
  trailingSlash: true,
  basePath: basePath || undefined,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default withMDX(config);
