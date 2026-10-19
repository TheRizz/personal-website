import { LayoutDashboard } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useOwner } from "./EditLink";
import { IconGroup, iconButtonClass } from "./IconButton";

// The header's admin menu: a shortcut to each section's drafts for the signed-in owner. Like the
// Edit link it renders nothing until the owner probe says yes, so visitors and prerendered HTML
// never see it.

/** One entry per section. Without `href` the section has no admin page yet. */
export const ADMIN_SECTIONS: readonly { label: string; href?: string }[] = [
  { label: "Blog posts", href: "/admin" },
  { label: "Photos", href: "/admin/photos" },
  { label: "Code snippets" },
];

export function AdminMenu() {
  const owner = useOwner();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Closes on a tap outside or Escape. Its links are full page loads, which close it too.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!owner) return null;
  return (
    // The menu hangs from the header row (SiteHeader's `relative`), so it lines up with its right
    // edge and stays on screen on a phone.
    <div ref={root}>
      <IconGroup label="Admin">
        <button
          type="button"
          aria-label="Admin"
          title="Admin"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((was) => !was)}
          className={iconButtonClass}
        >
          <LayoutDashboard />
        </button>
      </IconGroup>
      {open && (
        <nav
          id={menuId}
          aria-label="Admin"
          className="absolute top-full right-0 z-50 mt-2 w-56 rounded-xl border border-line bg-bg p-1.5 shadow-lg"
        >
          <p className="px-3 pt-1.5 pb-1 text-[0.7rem] font-semibold tracking-[0.08em] text-muted uppercase">
            Drafts
          </p>
          <ul>
            {ADMIN_SECTIONS.map(({ label, href }) => (
              <li key={label}>
                {href ? (
                  // A plain link is a full page load: the Worker serves admin pages behind Access.
                  <a
                    href={href}
                    className="block rounded-lg px-3 py-2.5 text-[0.95rem] font-medium hover:bg-surface-hover"
                  >
                    {label}
                  </a>
                ) : (
                  <span className="block px-3 py-2.5 text-[0.95rem] text-muted">
                    {label} <span className="text-[0.8rem]">(not built yet)</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
