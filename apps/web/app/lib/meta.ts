import { site } from "~/site";

interface PageMeta {
  /** Page title; omit for the home page. */
  title?: string;
  description?: string;
  path: string;
  type?: "website" | "article";
}

/** Title, description, canonical URL and Open Graph tags for a route's `meta` export. */
export function pageMeta({
  title,
  description = site.description,
  path,
  type = "website",
}: PageMeta) {
  const fullTitle = title ? `${title} · ${site.name}` : site.name;
  const url = new URL(path, site.url).href;
  return [
    { title: fullTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:type", content: type },
    { property: "og:url", content: url },
    { property: "og:title", content: fullTitle },
    { property: "og:description", content: description },
    { name: "twitter:card", content: "summary" },
  ];
}
