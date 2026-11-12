import { expect, test } from "@playwright/test";
import { GENERATORS, type GameState } from "@site/tycoon-core";

// The late-game scene on a phone with a slow CPU: every tier owned in the thousands, overclocked,
// and the core tapped ten times a second. Frame times go in the report (CI machines vary too much
// to fail on them); what the scene draws at once must stay inside its caps (scene-budget.ts).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("a late game on a slow phone keeps packets, numbers and rings inside their caps", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // This tab's copy only; the test never saves, so the server's game stays new.
  await page.route("**/api/tycoon/session", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { state: GameState };
    body.state.owned = GENERATORS.map(() => 5000);
    body.state.overclockUntil = body.state.playMs + 600_000;
    await route.fulfill({ response, json: body });
  });
  const cdp = await page.context().newCDPSession(page);
  await page.goto("/games/pipeline-tycoon");
  const scene = page.getByRole("button", { name: /^Factory/ });
  const canvas = scene.locator("canvas");
  await expect(canvas).toBeVisible();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.waitForTimeout(3000);

  const box = (await scene.boundingBox())!;
  const tapping = (async () => {
    for (let i = 0; i < 40; i++) {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(100);
    }
  })();
  const frames = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const gaps: number[] = [];
        let last = performance.now();
        const end = last + 5000;
        const step = (now: number) => {
          gaps.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(step);
          else resolve(gaps);
        };
        requestAnimationFrame(step);
      }),
  );
  const drawn = await canvas.evaluate((element) => ({ ...(element as HTMLElement).dataset }));
  await tapping;
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  frames.sort((a, b) => a - b);
  const at = (q: number) => frames[Math.floor(q * (frames.length - 1))]!.toFixed(1);
  const mean = frames.reduce((sum, gap) => sum + gap, 0) / frames.length;
  test.info().annotations.push({
    type: "frame time (ms, 4x slower CPU)",
    description: `mean ${mean.toFixed(1)}, median ${at(0.5)}, 95th ${at(0.95)}, worst ${at(1)}`,
  });
  await page.screenshot({ path: "test-results/tycoon-late-phone.png" });

  // Busy, but inside the caps: every tier's stream shows, numbers and rings are reused.
  expect(Number(drawn.packets)).toBeGreaterThan(30);
  expect(Number(drawn.packets)).toBeLessThanOrEqual(150);
  expect(Number(drawn.floats)).toBeGreaterThan(0);
  expect(Number(drawn.floats)).toBeLessThanOrEqual(6);
  expect(Number(drawn.bursts)).toBeLessThanOrEqual(8);
});
