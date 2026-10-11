import { Search } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router";
import { iconButtonClass } from "./IconButton";

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const noSubscribe = () => () => {};
const clientModifier = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl");
const serverModifier = () => "Ctrl";

/** Opens search. Ctrl+K, Cmd+K or "/" also work from anywhere on the page. */
export function SearchButton() {
  const navigate = useNavigate();
  const modifier = useSyncExternalStore(noSubscribe, clientModifier, serverModifier);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const shortcut =
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") ||
        (event.key === "/" && !isTyping(event.target));
      if (!shortcut) return;
      event.preventDefault();
      navigate("/search");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <Link
      to="/search"
      aria-label="Search"
      title="Search"
      aria-keyshortcuts="Control+K Meta+K /"
      className={`${iconButtonClass} sm:pr-2`}
    >
      <Search />
      <span
        aria-hidden="true"
        className="hidden rounded-md border border-line bg-surface px-1.5 text-[0.68rem] leading-5 font-semibold text-muted sm:inline"
      >
        <kbd className="font-sans">{modifier}</kbd> K
      </span>
    </Link>
  );
}
