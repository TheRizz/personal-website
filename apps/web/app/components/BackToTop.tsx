import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";

/** Round button in the bottom corner that appears after scrolling down. */
export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const update = () => setVisible(window.scrollY > 600);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <button
      type="button"
      aria-label="Back to top"
      tabIndex={visible ? 0 : -1}
      onClick={() => window.scrollTo({ top: 0 })}
      className={`fixed right-6 bottom-8 z-40 flex size-12 items-center justify-center rounded-full border border-fg bg-bg text-fg transition duration-300 hover:-translate-y-0.5 ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <ArrowUp className="size-5" />
    </button>
  );
}
