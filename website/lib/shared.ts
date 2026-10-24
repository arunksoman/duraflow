import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Duraflow';
export const docsRoute = '/docs';
export const docsContentRoute = '/llms.mdx/docs';

/** The GitHub Pages path prefix (empty locally). Prepend it to any raw asset URL. */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const gitConfig = {
  user: 'arunksoman',
  repo: 'duraflow',
  branch: 'main',
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}
