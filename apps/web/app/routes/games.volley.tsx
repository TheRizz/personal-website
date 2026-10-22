import { PageHeading } from "~/components/PageHeading";
import { VolleyGame } from "~/components/games/volley/VolleyGame";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/games.volley";

const DESCRIPTION =
  "Side-view arcade volleyball after Powa Volley Classic: 1v1 or 2v2, against the computer, a friend on the same device, or a friend online.";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "Power Volley", description: DESCRIPTION, path: "/games/volley" });

export default function Volley() {
  return (
    <>
      <PageHeading title="Power Volley" compact>
        Arcade volleyball, after Powa Volley Classic.
      </PageHeading>
      <VolleyGame />
    </>
  );
}
