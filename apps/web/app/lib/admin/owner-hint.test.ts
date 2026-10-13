import { describe, expect, it } from "vitest";
import { hasOwnerHint } from "./owner-hint";

describe("hasOwnerHint", () => {
  it("finds the hint alone, first, last or with spaces around it", () => {
    for (const cookie of [
      "owner_hint=1",
      " owner_hint=1",
      "owner_hint=1 ",
      "theme=dark; owner_hint=1",
      "owner_hint=1; theme=dark",
      "a=1;owner_hint=1;b=2",
    ]) {
      expect(hasOwnerHint(cookie), cookie).toBe(true);
    }
  });

  it("ignores other values, other names and the hint inside another cookie", () => {
    for (const cookie of [
      "",
      "owner_hint",
      "owner_hint=",
      "owner_hint=0",
      "owner_hint=11",
      "owner_hint=1x",
      "owner_hint = 1",
      "Owner_hint=1",
      "xowner_hint=1",
      "my_owner_hint=1",
      "theme=owner_hint=1",
      "theme=dark, owner_hint=1",
    ]) {
      expect(hasOwnerHint(cookie), cookie).toBe(false);
    }
  });
});
