import { describe, expect, it } from "vitest";
import { EMOJIS, emojiQuery, matchEmojis } from "./emoji";

const at = (text: string) => emojiQuery(text, text.length);

describe("emojiQuery", () => {
  it("triggers at the start and after whitespace / openers", () => {
    expect(at(":r")).toEqual({ start: 0, query: "r" });
    expect(at("ship it :roc")).toEqual({ start: 8, query: "roc" });
    expect(at("line\n:fi")).toEqual({ start: 5, query: "fi" });
    expect(at("(:+1")).toEqual({ start: 1, query: "+1" });
  });

  it("ignores URLs, times, mid-word colons and a bare colon", () => {
    expect(at("see http://x")).toBeNull();
    expect(at("at 12:30")).toBeNull();
    expect(at("foo:bar")).toBeNull();
    expect(at("hello :")).toBeNull();
    expect(at(":rocket ")).toBeNull();
  });

  it("reads the text before the caret, not the whole draft", () => {
    expect(emojiQuery(":ro and more", 3)).toEqual({ start: 0, query: "ro" });
    expect(emojiQuery("abc :ro", 3)).toBeNull();
  });
});

describe("matchEmojis", () => {
  it("offers the rocket for :r and ranks it first for :rock", () => {
    expect(matchEmojis("r").map((e) => e.e)).toContain("🚀");
    expect(matchEmojis("rock")[0].e).toBe("🚀");
  });

  it("puts an exact name ahead of prefix hits", () => {
    expect(matchEmojis("x")[0].n).toBe("x");
  });

  it("matches name segments and keywords", () => {
    expect(matchEmojis("check").map((e) => e.n)).toContain("white_check_mark");
    expect(matchEmojis("deploy").map((e) => e.e)).toContain("🚀");
  });

  it("is case-insensitive, deduped by glyph, and limited", () => {
    expect(matchEmojis("ROCK")[0].e).toBe("🚀");
    const thumbs = matchEmojis("thumbs").map((e) => e.e);
    expect(new Set(thumbs).size).toBe(thumbs.length);
    expect(matchEmojis("s", 5)).toHaveLength(5);
    expect(matchEmojis("zzzzqq")).toEqual([]);
  });

  it("has no duplicate shortcode names", () => {
    const names = EMOJIS.map((e) => e.n);
    expect(new Set(names).size).toBe(names.length);
  });
});
