import { Mail } from "lucide-react";
import { Link, NavLink } from "react-router";
import { site } from "~/site";
import { GitHubIcon } from "./icons";
import { IconGroup, iconButtonClass } from "./IconButton";
import { SearchButton } from "./SearchButton";
import { ThemeToggle } from "./ThemeToggle";

export function SiteHeader() {
  return (
    <header className="mb-8 border-b border-line pb-4">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/"
          className="-ml-2 rounded-lg px-2 py-1 text-[1.35rem] leading-none font-extrabold tracking-[-0.03em] transition duration-200 ease-spring active:scale-95 sm:text-[1.6rem]"
        >
          {site.name}
        </Link>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <IconGroup label="Elsewhere">
            <a
              href={site.github}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              title="GitHub"
              className={iconButtonClass}
            >
              <GitHubIcon />
            </a>
            <a
              href={`mailto:${site.email}`}
              aria-label="Email"
              title="Email"
              className={iconButtonClass}
            >
              <Mail />
            </a>
          </IconGroup>
          <IconGroup label="Site tools">
            <SearchButton />
            <ThemeToggle />
          </IconGroup>
        </div>
      </div>
      <nav aria-label="Main" className="mt-4">
        <ul className="flex flex-wrap gap-x-2.5 gap-y-1 text-[0.75rem] font-semibold tracking-[0.06em] uppercase sm:gap-x-5 sm:text-[0.8rem] sm:tracking-[0.08em]">
          {site.nav.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `underline-offset-[6px] transition-colors hover:text-fg ${
                    isActive ? "text-fg underline decoration-underline" : "text-muted"
                  }`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
