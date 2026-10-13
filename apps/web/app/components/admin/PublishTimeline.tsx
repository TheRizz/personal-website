import { Circle, CircleCheck, CircleDot, CircleX, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { PublishState, Stage } from "~/lib/admin/publish";

// The publish timeline (design doc §4.9.7): PR opened → CI → review → merged → deploying → Live.
// An ordered list with the current step marked `aria-current="step"`, so a screen reader hears
// where the pull request is, not only a sighted owner.

/** The timeline step each stage is at. `draft` and `closed` have no pull request to show. */
const STEP_OF: Partial<Record<Stage, number>> = {
  opened: 0,
  ci_running: 1,
  ci_failed: 1,
  review: 2,
  merged: 3,
  deploying: 4,
  deploy_failed: 4,
  live: 5,
};

/** Whether `stage` has a timeline: a pull request that is open, merged or live. */
export function hasTimeline(stage: Stage): boolean {
  return STEP_OF[stage] !== undefined;
}

interface Step {
  /** The step's name, as the e2e tests find it. */
  label: ReactNode;
  /** How long the step usually takes, shown until it is done. */
  hint?: string;
  failed?: boolean;
  /** A link or note shown beside the current step. */
  extra?: ReactNode;
}

function StepLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="link font-semibold">
      {children}
    </a>
  );
}

/** The steps for `state`, failed ones named as such. */
function stepsOf(state: PublishState): Step[] {
  const pr = state.pr === null ? "PR" : `PR #${state.pr}`;
  const run = state.runUrl ? <StepLink href={state.runUrl}>View the run</StepLink> : null;
  const live =
    state.action === "unpublish" ? (
      <span>Removed from the site</span>
    ) : state.slug ? (
      // A full page load: the public post isn't part of the admin app.
      <StepLink href={`/blog/${state.slug}`}>View the post</StepLink>
    ) : null;
  return [
    { label: <>{state.prUrl ? <StepLink href={state.prUrl}>{pr}</StepLink> : pr} opened</> },
    state.stage === "ci_failed"
      ? { label: "CI failed", failed: true, extra: run }
      : { label: "CI running", hint: "about 2 min" },
    { label: "Waiting for your review" },
    { label: "Merged" },
    state.stage === "deploy_failed"
      ? { label: "Deploy failed", failed: true, extra: run }
      : { label: "Deploying", hint: "about 1 min", extra: run },
    { label: "Live", extra: live },
  ];
}

/** The icon for a step: done, failed, under way, waiting on the owner, or still to come. */
function StepIcon({
  state,
  at,
  current,
  failed,
}: {
  state: PublishState;
  at: number;
  current: number;
  failed: boolean;
}) {
  const icon = "mt-0.5 size-5 shrink-0";
  if (failed) {
    return <CircleX aria-hidden="true" className={`${icon} text-red-700 dark:text-red-400`} />;
  }
  if (at < current || state.stage === "live") {
    return (
      <CircleCheck
        aria-hidden="true"
        className={`${icon} text-emerald-700 dark:text-emerald-400`}
      />
    );
  }
  if (at > current) return <Circle aria-hidden="true" className={`${icon} text-muted/60`} />;
  // GitHub is working on it (CI, the deploy); otherwise it waits for the owner or the next step.
  if (state.stage === "ci_running" || state.stage === "deploying") {
    return <LoaderCircle aria-hidden="true" className={`${icon} motion-safe:animate-spin`} />;
  }
  return <CircleDot aria-hidden="true" className={icon} />;
}

/** The timeline for a pull request; nothing for a draft without one. */
export function PublishTimeline({ state }: { state: PublishState }) {
  const current = STEP_OF[state.stage];
  if (current === undefined) return null;
  return (
    <ol aria-label="Publish progress" className="space-y-2.5">
      {stepsOf(state).map((step, at) => {
        const done = at < current;
        const isCurrent = at === current;
        return (
          <li
            key={at}
            aria-current={isCurrent ? "step" : undefined}
            className={`flex gap-2.5 ${at > current ? "text-muted" : ""}`}
          >
            <StepIcon state={state} at={at} current={current} failed={isCurrent && !!step.failed} />
            <p className="min-w-0 [overflow-wrap:anywhere]">
              <span className={isCurrent ? "font-semibold" : ""}>{step.label}</span>
              {done && <span className="sr-only"> (done)</span>}
              {step.hint && !done && <span className="text-sm text-muted"> ({step.hint})</span>}
              {isCurrent && step.extra && (
                <>
                  {" "}
                  <span className="ml-1 text-sm">{step.extra}</span>
                </>
              )}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
