import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(), getProxyPoolById: vi.fn(),
  updateProviderConnection: vi.fn(), deleteProviderConnection: vi.fn(), getApiKeys: vi.fn(),
}));
vi.mock("@/models", () => db);
import { PUT } from "@/app/api/providers/[id]/route.js";

async function update(body) {
  return PUT(new Request("http://localhost/api/providers/account", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "account" }) });
}

describe("account quota sharing configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.getProviderConnectionById.mockResolvedValue({ id: "account", provider: "claude", authType: "oauth" });
    db.getApiKeys.mockResolvedValue([{ id: "active", isActive: true }, { id: "disabled", isActive: false }]);
    db.updateProviderConnection.mockImplementation(async (id, patch) => ({ id, ...patch, accessToken: "secret" }));
  });

  it.each([null, [], {}, { enabled: "true", apiKeyIds: ["active"] },
    { enabled: true, apiKeyIds: [] }, { enabled: true, apiKeyIds: ["missing"] },
    { enabled: true, apiKeyIds: ["disabled"] }, { enabled: true, apiKeyIds: [null] },
  ])("rejects invalid or unavailable memberships: %j", async (quotaSharing) => {
    expect((await update({ quotaSharing })).status).toBe(400);
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("stores unique IDs only, not caller-provided usage, and hides credentials", async () => {
    const response = await update({ quotaSharing: { enabled: true, apiKeyIds: ["active", "active"], used: 0 } });
    expect(response.status).toBe(200);
    expect(db.updateProviderConnection).toHaveBeenCalledWith("account", { quotaSharing: { enabled: true, apiKeyIds: ["active"] } });
    expect((await response.json()).connection.accessToken).toBeUndefined();
  });

  it("can disable sharing even after a selected key is deleted", async () => {
    expect((await update({ quotaSharing: { enabled: false, apiKeyIds: ["deleted"] } })).status).toBe(200);
    expect(db.getApiKeys).not.toHaveBeenCalled();
  });

  it("leaves legacy edits and existing sharing untouched when omitted", async () => {
    expect((await update({ name: "Renamed" })).status).toBe(200);
    expect(db.updateProviderConnection).toHaveBeenCalledWith("account", { name: "Renamed" });
    expect(db.getApiKeys).not.toHaveBeenCalled();
  });
});
