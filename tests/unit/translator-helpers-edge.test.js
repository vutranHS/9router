// Locks edge cases flagged in docs 11 §1/§4 that were only covered indirectly.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { parseDataUri, encodeDataUri } from "../../open-sse/translator/concerns/image.js";

describe("normalizeClaudePassthrough — haiku adaptive thinking (docs 11 §1)", () => {
  it("downgrades adaptive thinking to enabled+budget for haiku models", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it("keeps adaptive thinking for sonnet/opus", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-sonnet-4-6");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  // Claude Code sends its own render mode ("highlights"); the API only takes
  // summarized/omitted/updates and 400s otherwise, whatever thinking.type says.
  it.each(["adaptive", "enabled", "disabled", undefined])(
    "coerces an off-spec display to summarized for type %s",
    (type) => {
      const out = normalizeClaudePassthrough({ thinking: { ...(type && { type }), display: "highlights" } }, "claude-opus-5");
      expect(out.thinking.display).toBe("summarized");
      expect(out.thinking.type).toBe(type);
    },
  );

  it.each(["summarized", "omitted", "updates"])("leaves the spec display %s untouched", (display) => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive", display } }, "claude-opus-5");
    expect(out.thinking).toEqual({ type: "adaptive", display });
  });

  it("leaves a body with no display alone", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-opus-5");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("does not mutate the caller's thinking object (reused across account fallback)", () => {
    const thinking = { type: "adaptive", display: "highlights" };
    normalizeClaudePassthrough({ thinking }, "claude-opus-5");
    expect(thinking.display).toBe("highlights");
  });

  it("hoists mid-conversation system messages into top-level system", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "be brief" },
      ],
    });
    expect(out.system).toEqual([{ type: "text", text: "be brief" }]);
    expect(out.messages.every((m) => m.role !== "system")).toBe(true);
  });
});

describe("parseDataUri / encodeDataUri (docs 11 §4)", () => {
  it("parses a base64 data uri", () => {
    expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({ mimeType: "image/png", base64: "AAAB" });
  });

  it("tolerates newlines inside base64 payload", () => {
    expect(parseDataUri("data:image/jpeg;base64,AA\nBB")?.base64).toBe("AA\nBB");
  });

  it("returns null for http urls and non-strings", () => {
    expect(parseDataUri("https://x/y.png")).toBeNull();
    expect(parseDataUri(null)).toBeNull();
  });

  it("encode/parse roundtrip", () => {
    const uri = encodeDataUri("image/webp", "ZZZ");
    expect(parseDataUri(uri)).toEqual({ mimeType: "image/webp", base64: "ZZZ" });
  });
});
