import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosaver, type AutosaveState } from "./autosave";
import type { DraftFields, SaveReason, SaveResult } from "./drafts";

const fields = (bodyMd: string): DraftFields => ({
  title: "T",
  summary: "",
  category: null,
  tags: [],
  bodyMd,
});

type SaveCall = { baseRev: number; fields: DraftFields; revision?: SaveReason };

function setup(
  respond: (call: SaveCall) => SaveResult | Promise<SaveResult> = (call) => ({
    ok: true,
    rev: call.baseRev + 1,
  }),
) {
  const calls: SaveCall[] = [];
  const states: AutosaveState[] = [];
  const saved: number[] = [];
  const saver = new Autosaver({
    rev: 1,
    save: async (baseRev, f, revision) => {
      const call = { baseRev, fields: f, revision };
      calls.push(call);
      return respond(call);
    },
    onChange: (state) => states.push(state),
    onSaved: (rev) => saved.push(rev),
    now: () => Date.now(),
  });
  return { saver, calls, states, saved };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Autosaver", () => {
  it("saves 2 s after the last change", async () => {
    const { saver, calls, saved } = setup();
    saver.change(fields("a"));
    await vi.advanceTimersByTimeAsync(1_000);
    saver.change(fields("ab"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ baseRev: 1, fields: fields("ab"), revision: undefined }]);
    expect(saver.current).toMatchObject({ status: "saved", rev: 2 });
    expect(saved).toEqual([2]);
    expect(saver.hasUnsavedChanges).toBe(false);
  });

  it("saves at least every 10 s while typing", async () => {
    const { saver, calls } = setup();
    for (let i = 0; i < 12; i++) {
      saver.change(fields(`x${i}`));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fields.bodyMd).toBe("x9");
  });

  it("keeps an interval revision at most every 10 minutes", async () => {
    const { saver, calls } = setup();
    saver.change(fields("a"));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    saver.change(fields("b"));
    await vi.advanceTimersByTimeAsync(2_000);
    saver.change(fields("c"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.map((c) => c.revision)).toEqual([undefined, "interval", undefined]);
  });

  it("Save keeps a manual revision right away", async () => {
    const { saver, calls } = setup();
    saver.change(fields("a"));
    await saver.flush("manual");
    expect(calls).toEqual([{ baseRev: 1, fields: fields("a"), revision: "manual" }]);
  });

  it("stops on a conflict until the owner overwrites", async () => {
    let conflict = true;
    const { saver, calls } = setup((call) =>
      conflict ? { ok: false, rev: 5, updatedAt: 123 } : { ok: true, rev: call.baseRev + 1 },
    );
    saver.change(fields("mine"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saver.current).toMatchObject({ status: "conflict", conflict: { rev: 5 } });
    saver.change(fields("mine, more"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(1);

    conflict = false;
    await saver.overwrite();
    expect(calls[1]).toEqual({ baseRev: 5, fields: fields("mine, more"), revision: "conflict" });
    expect(saver.current).toMatchObject({ status: "saved", rev: 6, conflict: null });
  });

  it("stops after 3 failures in a row and retries on request", async () => {
    let fail = true;
    const { saver, calls } = setup((call) => {
      if (fail) throw new Error("offline");
      return { ok: true, rev: call.baseRev + 1 };
    });
    saver.change(fields("a"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saver.current).toMatchObject({ status: "error", errors: 1 });
    saver.change(fields("b"));
    await vi.advanceTimersByTimeAsync(2_000);
    saver.change(fields("c"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saver.current).toMatchObject({ status: "stopped", errors: 3 });
    saver.change(fields("d"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(3);
    expect(saver.hasUnsavedChanges).toBe(true);

    fail = false;
    await saver.retry();
    expect(calls.at(-1)?.fields.bodyMd).toBe("d");
    expect(saver.current).toMatchObject({ status: "saved", errors: 0 });
  });

  it("saves changes made during a save afterwards", async () => {
    let finish: (result: SaveResult) => void = () => {};
    const { saver, calls } = setup(
      (call) =>
        new Promise<SaveResult>((resolve) => {
          finish = resolve;
          void call;
        }),
    );
    saver.change(fields("a"));
    await vi.advanceTimersByTimeAsync(2_000);
    saver.change(fields("ab"));
    finish({ ok: true, rev: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.current.status).toBe("dirty");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls[1]).toMatchObject({ baseRev: 2, fields: fields("ab") });
  });

  it("saves nothing while disposed, and the changes made meanwhile once revived", async () => {
    const { saver, calls } = setup();
    saver.dispose();
    saver.change(fields("a"));
    await vi.advanceTimersByTimeAsync(20_000);
    await saver.flush("manual");
    expect(calls).toHaveLength(0);
    expect(saver.current.status).toBe("dirty");

    // The editor revives it when the server refuses a discard.
    saver.revive();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual([{ baseRev: 1, fields: fields("a"), revision: undefined }]);
    expect(saver.current).toMatchObject({ status: "saved", rev: 2 });
    expect(saver.hasUnsavedChanges).toBe(false);
  });

  it("reset takes the server's rev and drops pending changes", async () => {
    const { saver, calls } = setup();
    saver.change(fields("a"));
    saver.reset(9, fields("server"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(0);
    expect(saver.current).toMatchObject({ status: "saved", rev: 9 });
  });
});
