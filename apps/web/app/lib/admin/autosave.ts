import type { DraftFields, SaveReason, SaveResult } from "./drafts";

// Autosave for the editor (design doc §4.9.5): 2 s after the last change, at most every 10 s
// while typing, a revision snapshot at most every 10 minutes of editing, and a stop after 3
// failures in a row. A save from a stale rev comes back as a conflict, and nothing is saved again
// until the owner reloads or overwrites. Plain TypeScript, so it is tested with fake timers.

export type AutosaveStatus = "saved" | "dirty" | "saving" | "error" | "stopped" | "conflict";

export interface AutosaveState {
  status: AutosaveStatus;
  /** The rev the next save is based on. */
  rev: number;
  /** Failures in a row. */
  errors: number;
  lastSavedAt: number | null;
  /** The rev and time of the save that won, while `status` is `conflict`. */
  conflict: { rev: number; updatedAt: number } | null;
}

export interface AutosaveOptions {
  rev: number;
  save: (baseRev: number, fields: DraftFields, revision?: SaveReason) => Promise<SaveResult>;
  onChange: (state: AutosaveState) => void;
  /** Called after every successful save, e.g. to tell other tabs. */
  onSaved?: (rev: number) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  snapshotEveryMs?: number;
  maxErrors?: number;
  now?: () => number;
}

export class Autosaver {
  private state: AutosaveState;
  private latest: DraftFields | null = null;
  private dirty = false;
  private saving = false;
  private queued: SaveReason | "change" | null = null;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private maxWait: ReturnType<typeof setTimeout> | undefined;
  private lastSnapshotAt: number;
  private disposed = false;
  private readonly options: Required<Omit<AutosaveOptions, "onSaved">> &
    Pick<AutosaveOptions, "onSaved">;

  constructor(options: AutosaveOptions) {
    this.options = {
      debounceMs: 2_000,
      maxWaitMs: 10_000,
      snapshotEveryMs: 10 * 60_000,
      maxErrors: 3,
      now: Date.now,
      ...options,
    };
    this.lastSnapshotAt = this.options.now();
    this.state = {
      status: "saved",
      rev: options.rev,
      errors: 0,
      lastSavedAt: null,
      conflict: null,
    };
  }

  get current(): AutosaveState {
    return this.state;
  }

  /** True while there are changes that haven't reached the server. */
  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  /** The editor's fields after a change. */
  change(fields: DraftFields) {
    this.latest = fields;
    this.dirty = true;
    if (this.state.status === "conflict" || this.state.status === "stopped") return;
    if (this.saving) {
      this.queued ??= "change";
      return;
    }
    this.update({ status: "dirty" });
    this.schedule();
  }

  /** Saves now. `manual` (the Save button) also keeps a revision. */
  async flush(revision?: SaveReason): Promise<void> {
    this.clearTimers();
    if (this.disposed) return;
    if (this.saving) {
      if (revision || !this.queued) this.queued = revision ?? "change";
      return;
    }
    if (!this.latest || (!this.dirty && !revision)) return;
    if (this.state.status === "conflict" && revision !== "conflict") return;

    const now = this.options.now();
    const reason =
      revision ??
      (now - this.lastSnapshotAt >= this.options.snapshotEveryMs ? "interval" : undefined);
    const sent = this.latest;
    this.saving = true;
    this.update({ status: "saving" });
    try {
      const result = await this.options.save(this.state.rev, sent, reason);
      if (this.disposed) return;
      if (!result.ok) {
        this.update({
          status: "conflict",
          conflict: { rev: result.rev, updatedAt: result.updatedAt },
        });
        return;
      }
      if (reason) this.lastSnapshotAt = now;
      if (this.latest === sent) this.dirty = false;
      this.update({
        status: this.dirty ? "dirty" : "saved",
        rev: result.rev,
        errors: 0,
        lastSavedAt: this.options.now(),
        conflict: null,
      });
      this.options.onSaved?.(result.rev);
    } catch {
      if (this.disposed) return;
      const errors = this.state.errors + 1;
      this.update({ status: errors >= this.options.maxErrors ? "stopped" : "error", errors });
    } finally {
      this.saving = false;
    }

    const queued = this.queued;
    this.queued = null;
    if (this.state.status === "conflict" || this.state.status === "stopped") return;
    if (queued && queued !== "change") await this.flush(queued);
    else if (this.dirty) this.schedule();
  }

  /** After a conflict: saves this tab's version over the other one, which is kept as a revision. */
  async overwrite(): Promise<void> {
    const { conflict } = this.state;
    if (!conflict) return;
    this.update({ rev: conflict.rev });
    this.dirty = true;
    await this.flush("conflict");
  }

  /** After a stop: tries again. */
  async retry(): Promise<void> {
    this.update({ status: this.dirty ? "dirty" : "saved", errors: 0 });
    await this.flush();
  }

  /** After the draft was reloaded from the server (Reload, Restore, another tab's save). */
  reset(rev: number, fields: DraftFields) {
    this.clearTimers();
    this.latest = fields;
    this.dirty = false;
    this.queued = null;
    this.update({ status: "saved", rev, errors: 0, conflict: null });
  }

  /** Stops all timers and ignores late results, e.g. when the page unmounts. */
  dispose() {
    this.disposed = true;
    this.clearTimers();
  }

  /** Sets the callback for successful saves (it may need things that exist only after mount). */
  setOnSaved(onSaved: ((rev: number) => void) | undefined) {
    this.options.onSaved = onSaved;
  }

  /** Undoes `dispose` (React mounts effects twice in development). */
  revive() {
    this.disposed = false;
    if (this.dirty && this.state.status !== "conflict" && this.state.status !== "stopped") {
      this.schedule();
    }
  }

  private schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flush(), this.options.debounceMs);
    this.maxWait ??= setTimeout(() => void this.flush(), this.options.maxWaitMs);
  }

  private clearTimers() {
    clearTimeout(this.debounce);
    clearTimeout(this.maxWait);
    this.debounce = undefined;
    this.maxWait = undefined;
  }

  private update(patch: Partial<AutosaveState>) {
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
  }
}
