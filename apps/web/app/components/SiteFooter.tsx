import { site } from "~/site";

export function SiteFooter() {
  return (
    <footer className="mt-16 flex flex-wrap justify-center gap-x-4 gap-y-1 pb-8 text-sm text-muted">
      <span>
        © {new Date().getFullYear()} {site.name}
      </span>
      <a href={site.github} target="_blank" rel="noopener noreferrer" className="link text-muted">
        GitHub
      </a>
      <a href={`mailto:${site.email}`} className="link text-muted">
        Email
      </a>
    </footer>
  );
}
