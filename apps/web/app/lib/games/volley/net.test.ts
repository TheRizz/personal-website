import { describe, expect, it } from "vitest";
import { decodeInput, encodeInput, parseClientMessage, parseCreateRoom } from "./net";

describe("inputs on the wire", () => {
  it("round-trips every combination of buttons", () => {
    for (let bits = 0; bits < 8; bits++) expect(encodeInput(decodeInput(bits))).toBe(bits);
    expect(encodeInput({ left: false, right: true, jump: true })).toBe(6);
  });
});

describe("parseClientMessage", () => {
  it("accepts each kind of message", () => {
    expect(parseClientMessage('{"t":"join","name":" Ryan ","character":"rio"}')).toEqual({
      t: "join",
      name: "Ryan",
      character: "rio",
    });
    expect(parseClientMessage('{"t":"input","f":120,"i":5}')).toEqual({ t: "input", f: 120, i: 5 });
    expect(parseClientMessage('{"t":"ping","c":12.5}')).toEqual({ t: "ping", c: 12.5 });
    expect(parseClientMessage('{"t":"pick","character":"zip"}')).toEqual({
      t: "pick",
      character: "zip",
    });
    expect(parseClientMessage('{"t":"ready"}')).toEqual({ t: "ready" });
    expect(parseClientMessage('{"t":"leave"}')).toEqual({ t: "leave" });
  });

  it.each([
    "nope",
    "[]",
    '{"t":"move"}',
    '{"t":"join","name":"","character":"rio"}',
    '{"t":"join","name":"Ryan","character":"pikachu"}',
    '{"t":"join","name":"Ryan","character":"rio","extra":1}',
    '{"t":"input","f":-1,"i":0}',
    '{"t":"input","f":1.5,"i":0}',
    '{"t":"input","f":1,"i":8}',
    '{"t":"ready","now":true}',
    `{"t":"ping","c":1,"pad":"${"x".repeat(600)}"}`,
  ])("rejects %s", (text) => {
    expect(parseClientMessage(text)).toBeNull();
  });
});

describe("parseCreateRoom", () => {
  it("takes a known court and target only", () => {
    expect(parseCreateRoom({ court: "jungle", target: 15 })).toEqual({
      court: "jungle",
      target: 15,
    });
    expect(parseCreateRoom({ court: "jungle", target: 12 })).toBeNull();
    expect(parseCreateRoom({ court: "mars", target: 11 })).toBeNull();
    expect(parseCreateRoom({ court: "beach", target: 11, game: "x" })).toBeNull();
    expect(parseCreateRoom(null)).toBeNull();
  });
});
