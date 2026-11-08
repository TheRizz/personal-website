import { PageHeading } from "~/components/PageHeading";
import { TycoonGame } from "~/components/games/tycoon/TycoonGame";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/games.pipeline-tycoon";

const DESCRIPTION =
  "An idle tycoon about data pipelines: start by copy-pasting CSVs, end by integrating the planet.";

/** The installable game: manifest, icons and the full-screen app files live here. */
const APP_DIR = "/games/pipeline-tycoon";

export const meta: Route.MetaFunction = () => [
  ...pageMeta({ title: "Pipeline Tycoon", description: DESCRIPTION, path: APP_DIR }),
  // "Add to Home Screen" on iPhone: open full screen, with a short name under the icon and a
  // black status bar over the dark scene.
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-title", content: "Tycoon" },
  { name: "apple-mobile-web-app-status-bar-style", content: "black" },
];

export const links: Route.LinksFunction = () => [
  { rel: "manifest", href: `${APP_DIR}/manifest.webmanifest` },
  { rel: "apple-touch-icon", href: `${APP_DIR}/icon-180.png`, sizes: "180x180" },
];

export default function PipelineTycoon() {
  return (
    <>
      <PageHeading title="Pipeline Tycoon" compact>
        Start by copy-pasting CSVs. End by integrating the planet.
      </PageHeading>
      <TycoonGame />
    </>
  );
}
