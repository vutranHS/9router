import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

describe("/api/keys/options exposes manually added models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", provider: "codex", email: "a@b.c", isActive: true },
    ]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
  });

  it("includes a custom codex model stored under the short alias", async () => {
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "cx", id: "gpt-6-codex", type: "llm" },
    ]);
    const { GET } = await import("@/app/api/keys/options/route.js");
    const data = await (await GET()).json();
    const ids = data.connections[0].models.map((m) => m.id);
    expect(ids).toContain("codex/gpt-6-codex");
  });

  it("includes a legacy alias-only model for this provider", async () => {
    mocks.getModelAliases.mockResolvedValue({ mymodel: "cx/gpt-5.6-sol" });
    const { GET } = await import("@/app/api/keys/options/route.js");
    const data = await (await GET()).json();
    const ids = data.connections[0].models.map((m) => m.id);
    expect(ids).toContain("codex/gpt-5.6-sol");
  });

  it("ignores custom models belonging to another provider", async () => {
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "cc", id: "claude-opus-9", type: "llm" },
    ]);
    const { GET } = await import("@/app/api/keys/options/route.js");
    const data = await (await GET()).json();
    const ids = data.connections[0].models.map((m) => m.id);
    expect(ids).not.toContain("codex/claude-opus-9");
  });
});
