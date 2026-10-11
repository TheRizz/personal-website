import { useLocation } from "react-router";
import { PageHeading } from "~/components/PageHeading";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/coming-soon";

const SECTIONS: Record<string, { title: string; description: string }> = {
  "/resume": { title: "Resume", description: "Work history, skills and projects." },
  "/snippets": { title: "Snippets", description: "Small pieces of code worth keeping." },
  "/photos": { title: "Photos", description: "A gallery of photos, grouped into albums." },
  "/games": { title: "Games", description: "Small multiplayer games you can play with a friend." },
  "/search": { title: "Search", description: "Search posts, snippets and photos." },
};

const sectionFor = (pathname: string) =>
  SECTIONS[pathname.replace(/\/$/, "")] ?? { title: "Coming soon", description: "" };

export const meta: Route.MetaFunction = ({ location }) => {
  const section = sectionFor(location.pathname);
  return pageMeta({ ...section, path: location.pathname });
};

/** Placeholder for sections that are built in later phases of the plan. */
export default function ComingSoon() {
  const section = sectionFor(useLocation().pathname);
  return (
    <PageHeading title={section.title}>
      {section.description} This section is coming soon.
    </PageHeading>
  );
}
