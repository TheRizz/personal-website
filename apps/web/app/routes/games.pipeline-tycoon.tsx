import { PageHeading } from "~/components/PageHeading";
import { TycoonGame } from "~/components/games/tycoon/TycoonGame";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/games.pipeline-tycoon";

const DESCRIPTION =
  "An idle tycoon about data pipelines: start by copy-pasting CSVs, end by integrating the planet.";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "Pipeline Tycoon", description: DESCRIPTION, path: "/games/pipeline-tycoon" });

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
