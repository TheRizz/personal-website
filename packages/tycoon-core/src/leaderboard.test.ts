import { describe, expect, it } from "vitest";
import { checkLeaderboardName } from "./leaderboard";

describe("leaderboard names", () => {
  it("accepts 3 to 16 letters, digits and underscores, trimmed", () => {
    expect(checkLeaderboardName("abc")).toEqual({ ok: true, name: "abc" });
    expect(checkLeaderboardName("  Data_Wizard_42 ")).toEqual({ ok: true, name: "Data_Wizard_42" });
    expect(checkLeaderboardName("a".repeat(16)).ok).toBe(true);
  });

  it("rejects the wrong length or characters", () => {
    expect(checkLeaderboardName("ab")).toEqual({ ok: false, problem: "length" });
    expect(checkLeaderboardName("a".repeat(17))).toEqual({ ok: false, problem: "length" });
    expect(checkLeaderboardName("data wizard")).toEqual({ ok: false, problem: "characters" });
    expect(checkLeaderboardName("café_au_lait")).toEqual({ ok: false, problem: "characters" });
    expect(checkLeaderboardName("<script>")).toEqual({ ok: false, problem: "characters" });
  });

  it("blocks profanity, also spelt with digits, repeats or underscores", () => {
    for (const name of [
      "shithead",
      "SH1T_lord",
      "f_u_c_k",
      "shiiiit",
      "big_ass",
      "BigAss",
      "ass69",
    ]) {
      expect(checkLeaderboardName(name), name).toEqual({ ok: false, problem: "blocked" });
    }
  });

  it("leaves ordinary words that contain a short blocked word alone", () => {
    for (const name of ["classic_pass", "therapist", "peacock", "spicy_tuna", "titan", "cumulus"]) {
      expect(checkLeaderboardName(name), name).toEqual({ ok: true, name });
    }
  });

  it("keeps names that pretend to be staff off the board", () => {
    expect(checkLeaderboardName("admin").ok).toBe(false);
    expect(checkLeaderboardName("the_moderator").ok).toBe(false);
  });
});
