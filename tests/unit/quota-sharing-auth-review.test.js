import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(), getApiKeys: vi.fn(), getSettings: vi.fn(),
  getProxyPools: vi.fn(), validateApiKey: vi.fn(), updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})), pickProxyPoolId: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
import { getProviderCredentials } from "@/sse/services/auth.js";

const account = (id, sharing) => ({ id, provider: "claude", isActive: true, ...(sharing ? { quotaSharing: sharing } : {}) });
const shared = () => account("shared", { enabled: true, apiKeyIds: ["member"] });
const select = (apiKey, excluded = null, options = {}) => getProviderCredentials("claude", excluded, "claude-sonnet-5", { apiKey, quotaRoute: "chat", ...options });

describe("quota sharing access review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.getProviderConnections.mockResolvedValue([shared()]);
    db.getApiKeys.mockResolvedValue([
      { id: "member", key: "member-secret", isActive: true },
      { id: "outsider", key: "outsider-secret", isActive: true },
    ]);
    db.getSettings.mockResolvedValue({});
  });

  it("allows only selected active key IDs", async () => {
    expect(await select("member-secret")).toMatchObject({ connectionId: "shared", quotaApiKeyId: "member" });
    expect(await select("outsider-secret")).toMatchObject({ accessDenied: true, status: 403 });
    expect(await select("member")).toMatchObject({ accessDenied: true, status: 403 });
    expect(await select(null)).toMatchObject({ accessDenied: true, status: 401 });
    db.getApiKeys.mockResolvedValue([{ id: "member", key: "member-secret", isActive: false }]);
    expect(await select("member-secret")).toMatchObject({ accessDenied: true, status: 403 });
  });

  it.each([[], null, "member", undefined])("enabled malformed membership fails closed: %j", async (apiKeyIds) => {
    db.getProviderConnections.mockResolvedValue([account("shared", { enabled: true, apiKeyIds })]);
    expect(await select("member-secret")).toMatchObject({ accessDenied: true });
  });

  it("keeps legacy accounts available but rejects an unauthorized explicit pin", async () => {
    db.getProviderConnections.mockResolvedValue([shared(), account("legacy")]);
    expect(await select("outsider-secret")).toMatchObject({ connectionId: "legacy" });
    expect(await select(null)).toMatchObject({ connectionId: "legacy" });
    expect(await select("outsider-secret", null, { preferredConnectionId: "shared" })).toMatchObject({ accessDenied: true });
  });

  it("does not misreport exhausted selected accounts as membership denial", async () => {
    db.getProviderConnections.mockResolvedValue([shared(), account("someone-else", { enabled: true, apiKeyIds: ["outsider"] })]);
    const result = await select("member-secret", new Set(["shared"]));
    expect(result?.accessDenied).not.toBe(true);
  });

  it("disabling sharing restores legacy routing", async () => {
    db.getProviderConnections.mockResolvedValue([account("shared", { enabled: false, apiKeyIds: ["member"] })]);
    expect(await select(null)).toMatchObject({ connectionId: "shared" });
  });
});
