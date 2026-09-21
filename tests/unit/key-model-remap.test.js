import { describe, it, expect, vi, beforeEach } from "vitest";

// Per-API-key model remap. Rules are keyed by the BARE model name and applied
// AFTER resolution, so one rule catches every spelling that resolves to it:
// `cc/x`, `claude/x`, an alias pointing at it, and combo members.
const mocks = vi.hoisted(() => ({
  getRemapForKey: vi.fn(),
  getModelAliases: vi.fn(),
  getComboByName: vi.fn(),
  getProviderNodes: vi.fn(),
}));

vi.mock("@/lib/keyModelRemapDb", () => ({
  getRemapForKey: mocks.getRemapForKey,
}));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: mocks.getModelAliases,
  getComboByName: mocks.getComboByName,
  getProviderNodes: mocks.getProviderNodes,
}));

const { getModelInfo } = await import("@/sse/services/model.js");

const FABLE = "claude-fable-5-1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getComboByName.mockResolvedValue(null);
  mocks.getProviderNodes.mockResolvedValue([]);
  mocks.getRemapForKey.mockResolvedValue({ [FABLE]: "cc/claude-opus-5" });
});

describe("getModelInfo — per-key model remap", () => {
  it("remaps a model addressed with its provider prefix", async () => {
    expect(await getModelInfo(`cc/${FABLE}`, "sk-a"))
      .toEqual({ provider: "claude", model: "claude-opus-5" });
  });

  it("matches on the bare name regardless of which provider prefix was used", async () => {
    expect(await getModelInfo(`claude/${FABLE}`, "sk-a"))
      .toEqual({ provider: "claude", model: "claude-opus-5" });
  });

  it("catches a model alias that resolves to the remapped model", async () => {
    mocks.getModelAliases.mockResolvedValue({ myfable: `cc/${FABLE}` });
    expect(await getModelInfo("myfable", "sk-a"))
      .toEqual({ provider: "claude", model: "claude-opus-5" });
  });

  it("leaves a model with no rule alone", async () => {
    const info = await getModelInfo("cc/claude-sonnet-5", "sk-a");
    expect(info.model).toBe("claude-sonnet-5");
  });

  it("does not remap when no API key is supplied (preview/local path)", async () => {
    const info = await getModelInfo(`cc/${FABLE}`);
    expect(info.model).toBe(FABLE);
    expect(mocks.getRemapForKey).not.toHaveBeenCalled();
  });

  it("leaves a combo name intact and never consults the remap table", async () => {
    mocks.getComboByName.mockResolvedValue({ name: "mycombo", models: [] });
    expect(await getModelInfo("mycombo", "sk-a")).toEqual({ provider: null, model: "mycombo" });
    expect(mocks.getRemapForKey).not.toHaveBeenCalled();
  });

  it("applies exactly once and never chains", async () => {
    mocks.getRemapForKey.mockResolvedValue({ "model-a": "cc/model-b", "model-b": "cc/model-c" });
    const info = await getModelInfo("cc/model-a", "sk-a");
    expect(info.model).toBe("model-b");
  });

  it("terminates on a cyclic rule pair", async () => {
    mocks.getRemapForKey.mockResolvedValue({ "model-a": "cc/model-b", "model-b": "cc/model-a" });
    const info = await getModelInfo("cc/model-a", "sk-a");
    expect(info.model).toBe("model-b");
  });

  it.each([["claude-opus-5"], [""], ["/x"], ["x/"], [42], [null], [{}]])(
    "ignores the malformed target %p and keeps the original model",
    async (target) => {
      mocks.getRemapForKey.mockResolvedValue({ [FABLE]: target });
      const info = await getModelInfo(`cc/${FABLE}`, "sk-a");
      expect(info.model).toBe(FABLE);
    }
  );

  it("fails open when the remap lookup throws", async () => {
    mocks.getRemapForKey.mockRejectedValue(new Error("db down"));
    const info = await getModelInfo(`cc/${FABLE}`, "sk-a");
    expect(info.model).toBe(FABLE);
  });
});
