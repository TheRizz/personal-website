import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./git-blob";

describe("gitBlobSha", () => {
  it.each([
    ["", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
    ["hello\n", "ce013625030ba8dba906f756967f9e9ca394464a"],
    // `printf 'café ☕\n' | git hash-object --stdin`: the length is in UTF-8 bytes.
    ["café ☕\n", "df113425d6f29a3f8cfb2ca897bebf8703e56d20"],
  ])("hashes %j like git", async (text, sha) => {
    expect(await gitBlobSha(text)).toBe(sha);
  });
});
