import { MarkdownError, renderMarkdown, type Highlighter } from "@site/content-markdown";
import { useEffect, useState } from "react";

// The live preview (design doc §4.9.3): the same renderMarkdown() and .prose CSS as the public
// post page, so it looks like the live post. Shiki loads on first use.

let highlighter: Promise<Highlighter | null> | undefined;

function loadHighlighter(): Promise<Highlighter | null> {
  highlighter ??= import("./highlighter")
    .then(({ createPreviewHighlighter }) => createPreviewHighlighter())
    // Without Shiki, code blocks still show, just without colours.
    .catch(() => null);
  return highlighter;
}

/** Renders `markdown` 300 ms after it stops changing. */
function useRendered(markdown: string): { html: string; error: string | null } {
  const [result, setResult] = useState<{ html: string; error: string | null }>({
    html: "",
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const shiki = await loadHighlighter();
      let next: { html: string; error: string | null };
      try {
        next = { html: (await renderMarkdown(markdown, { highlighter: shiki })).html, error: null };
      } catch (error) {
        if (error instanceof MarkdownError) {
          next = { html: "", error: error.message };
        } else {
          // A language Shiki hasn't loaded, for example: show the post without highlighting.
          try {
            next = { html: (await renderMarkdown(markdown)).html, error: null };
          } catch (fallback) {
            next = { html: "", error: String(fallback) };
          }
        }
      }
      if (!cancelled) setResult(next);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [markdown]);
  return result;
}

export function Preview({ title, markdown }: { title: string; markdown: string }) {
  const { html, error } = useRendered(markdown);
  return (
    <article aria-label="Preview">
      <h1 className="mb-8 text-3xl leading-tight font-extrabold tracking-[-0.03em] text-balance sm:text-4xl">
        {title.trim() || <span className="text-muted">Untitled</span>}
      </h1>
      {error ? (
        <p role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
          {error}
        </p>
      ) : (
        // Sanitized by renderMarkdown's rehype-sanitize schema, the same as the build.
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </article>
  );
}
