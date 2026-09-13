import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ needsRefresh: () => false }),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({}),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, GET, account;
const until = "2099-01-01T00:00:00.000Z";
const normalKey = "modelLock_gpt-5.4";
const reviewKey = "modelLock_gpt-5.4-review";
const sparkKey = "modelLock_gpt-5.3-codex-spark";
const quota = (session = 0, weekly = 0) => ({
  primary_window: { used_percent: session },
  secondary_window: { used_percent: weekly },
});
const refresh = (query = "?force=1") => GET(new Request(`http://localhost/api/usage/${account.id}${query}`), {
  params: Promise.resolve({ connectionId: account.id }),
});
const read = () => db.getProviderConnectionById(account.id);
const respond = (body, status = 200) => mocks.fetch.mockResolvedValue(Response.json(body, { status }));

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quota-recovery-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ GET } = await import("@/app/api/usage/[connectionId]/route.js"));
});

beforeEach(async () => {
  vi.clearAllMocks();
  account = await db.createProviderConnection({ provider: "codex", authType: "oauth", accessToken: "test-token" });
  account = await db.updateProviderConnection(account.id, {
    [normalKey]: until,
    codexQuotaLocks: { [normalKey]: until },
    testStatus: "unavailable", errorCode: 429, backoffLevel: 2,
    lastError: "You have hit your ChatGPT usage limit.",
    lastErrorAt: "2026-09-14T03:00:00.000Z",
    providerSpecificData: { workspaceId: "test-workspace" },
  });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Codex quota refresh recovery", () => {
  it.each(["pro", "business", "team"])("uses the single weekly main quota for %s and ignores exhausted Spark", async (plan) => {
    respond({
      plan_type: plan,
      rate_limit: { primary_window: { used_percent: 25 }, secondary_window: null },
      spark_rate_limit: quota(100, 100),
    });
    const response = await refresh();
    const usage = await response.json();
    expect(usage.quotaAvailable).toMatchObject({ normal: true, spark: false });
    expect(parseQuotaData("codex", usage).find((entry) => entry.quotaType === "session").name).toBe("Weekly");
    expect(await read()).toMatchObject({ [normalKey]: null, testStatus: "active" });
  });

  it("recognizes an explicit weekly primary window without guessing the plan", async () => {
    respond({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 } } });
    await refresh();
    expect(await read()).toMatchObject({ [normalKey]: null, testStatus: "active" });
  });

  it.each(["plus", "k12"])("requires both 5h and weekly to recover for %s", async (plan) => {
    respond({ plan_type: plan, rate_limit: quota(0, 100) });
    const usage = await (await refresh()).json();
    expect(parseQuotaData("codex", usage).map((entry) => entry.name)).toEqual(["5h", "Weekly"]);
    expect(await read()).toMatchObject({ [normalKey]: until });
    respond({ plan_type: plan, rate_limit: quota(0, 0) });
    await refresh();
    expect(await read()).toMatchObject({ [normalKey]: null, testStatus: "active" });
  });

  it.each(["pro", "business"])("keeps an exhausted single weekly quota locked for %s", async (plan) => {
    respond({ plan_type: plan, rate_limit: { primary_window: { used_percent: 100 } }, spark_rate_limit: quota() });
    await refresh();
    expect(await read()).toMatchObject({ [normalKey]: until });
  });

  it("does not infer a weekly window when upstream explicitly reports 5h", async () => {
    respond({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } } });
    const usage = await (await refresh()).json();
    expect(parseQuotaData("codex", usage)[0].name).toBe("5h");
    expect(await read()).toMatchObject({ [normalKey]: until });
  });

  it.each(["?force=1", ""])("fetches fresh account quota and clears recovered locks (%s)", async (query) => {
    respond({ rate_limit: quota(10, 20) });
    expect((await refresh(query)).status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({ cache: "no-store", headers: expect.objectContaining({ "ChatGPT-Account-ID": "test-workspace" }) }),
      expect.any(Object),
    );
    expect(await read()).toMatchObject({
      [normalKey]: null, codexQuotaLocks: {}, testStatus: "active",
      errorCode: null, lastError: null, lastErrorAt: null, backoffLevel: 0,
    });
  });

  it.each([
    ["weekly exhausted despite full 5h", quota(0, 100)],
    ["5h exhausted", quota(100, 0)],
    ["missing weekly", { primary_window: { used_percent: 0 } }],
    ["missing percentages", { primary_window: {}, secondary_window: {} }],
    ["invalid percentage", quota("bad", 0)],
    ["negative percentage", quota(-1, 0)],
    ["null percentage", quota(null, 0)],
    ["limit reached", { ...quota(), limit_reached: true }],
    ["not allowed", { ...quota(), allowed: false }],
  ])("keeps cooldown when %s", async (_name, rateLimit) => {
    respond({ rate_limit: rateLimit });
    expect((await refresh()).status).toBe(200);
    expect(await read()).toMatchObject({ [normalKey]: until, testStatus: "unavailable" });
  });

  it("keeps locks when the upstream quota API fails", async () => {
    respond({ error: "unavailable" }, 503);
    await refresh();
    expect(await read()).toMatchObject({ [normalKey]: until, testStatus: "unavailable" });
  });

  it("only clears recovered families and preserves unrelated model errors", async () => {
    const authKey = "modelLock_gpt-5.5";
    await db.updateProviderConnection(account.id, {
      [reviewKey]: until, [sparkKey]: until, [authKey]: until,
      codexQuotaLocks: { [normalKey]: until, [reviewKey]: until, [sparkKey]: until },
    });
    respond({ rate_limit: quota(), code_review_rate_limit: quota(0, 100), spark_rate_limit: quota(100, 0) });
    await refresh();
    expect(await read()).toMatchObject({
      [normalKey]: null, [reviewKey]: until, [sparkKey]: until, [authKey]: until, testStatus: "unavailable",
    });

    respond({ rate_limit: quota(), code_review_rate_limit: quota(), spark_rate_limit: quota() });
    await refresh();
    expect(await read()).toMatchObject({
      [reviewKey]: null, [sparkKey]: null, [authKey]: until, testStatus: "unavailable", codexQuotaLocks: {},
    });
  });

  it("recovers an unambiguous usage lock saved before per-model tracking", async () => {
    await db.updateProviderConnection(account.id, { codexQuotaLocks: null });
    respond({ rate_limit: quota() });
    await refresh();
    expect(await read()).toMatchObject({ [normalKey]: null, testStatus: "active" });
  });

  it("preserves an old authentication lock even when quota is available", async () => {
    await db.updateProviderConnection(account.id, { codexQuotaLocks: null, errorCode: 401, lastError: "Unauthorized" });
    respond({ rate_limit: quota() });
    await refresh();
    expect(await read()).toMatchObject({ [normalKey]: until, errorCode: 401 });
  });

  it("does not clear a newer error recorded during the quota fetch", async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      await db.updateProviderConnection(account.id, { lastErrorAt: "2026-09-14T04:00:00.000Z" });
      return Response.json({ rate_limit: quota() });
    });
    await refresh();
    expect(await read()).toMatchObject({ [normalKey]: until, testStatus: "unavailable" });
  });
});
