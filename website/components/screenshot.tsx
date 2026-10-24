import { basePath } from '@/lib/shared';

interface ScreenshotProps {
  /** File stem under `public/screenshots/` — `<name>-light.webp` and `<name>-dark.webp` must both exist. */
  name: string;
  alt: string;
  caption?: string;
}

/**
 * A screenshot of the app taken in both of its themes. Both images are in the page; CSS shows the
 * one matching the docs theme (fumadocs puts `class="dark"` on <html>), so toggling the theme swaps
 * the screenshot instantly, with no flash and no client-side JavaScript.
 */
export function Screenshot({ name, alt, caption }: ScreenshotProps) {
  const src = (theme: 'light' | 'dark') => `${basePath}/screenshots/${name}-${theme}.webp`;
  return (
    <figure className="not-prose my-6">
      <a href={src('light')} target="_blank" rel="noreferrer" className="block dark:hidden">
        <img src={src('light')} alt={alt} loading="lazy" className="rounded-lg border shadow-sm" />
      </a>
      <a href={src('dark')} target="_blank" rel="noreferrer" className="hidden dark:block">
        <img src={src('dark')} alt={alt} loading="lazy" className="rounded-lg border shadow-sm" />
      </a>
      {caption ? (
        <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
