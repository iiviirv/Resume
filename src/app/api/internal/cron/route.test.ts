import { beforeEach, describe, expect, it, vi } from "vitest";

import { startDueRun } from "@/lib/agent/schedule";
import { cronAuthorized } from "@/lib/cron-auth";
import { sweepFinishedJobs } from "@/lib/jobs/retention";
import { prisma } from "@/lib/prisma";

import { GET, POST } from "./route";

vi.mock("@/lib/agent/schedule", () => ({ startDueRun: vi.fn() }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: vi.fn() }));
vi.mock("@/lib/jobs/retention", () => ({ sweepFinishedJobs: vi.fn() }));
vi.mock("@/lib/log", () => ({ logServerError: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { job: { count: vi.fn() } } }));

beforeEach(() => { vi.resetAllMocks(); vi.mocked(cronAuthorized).mockReturnValue(true); });
const request = () => new Request("http://container/api/internal/cron");

describe("internal cron endpoint", () => {
  it("rejects requests before touching data or schedules", async () => {
    vi.mocked(cronAuthorized).mockReturnValue(false);
    for (const handler of [GET, POST]) {
      const response = await handler(request());
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(startDueRun).not.toHaveBeenCalled();
    expect(sweepFinishedJobs).not.toHaveBeenCalled();
    expect(prisma.job.count).not.toHaveBeenCalled();
  });

  it("coalesces concurrent ticks and waits for the scheduling check", async () => {
    let finish!: () => void;
    vi.mocked(startDueRun).mockImplementation(() => new Promise<null>((resolve) => { finish = () => resolve(null); }));
    const first = POST(request());
    const second = POST(request());
    await vi.waitFor(() => expect(startDueRun).toHaveBeenCalledTimes(1));
    finish();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(sweepFinishedJobs).toHaveBeenCalledTimes(1);
  });

  it("reports unfinished jobs so the idle hook preserves work", async () => {
    vi.mocked(prisma.job.count).mockResolvedValue(1);
    expect(await (await GET(request())).json()).toEqual({ busy: true });
    vi.mocked(prisma.job.count).mockResolvedValue(0);
    expect(await (await GET(request())).json()).toEqual({ busy: false });
  });

  it("returns generic failures and allows a subsequent tick", async () => {
    vi.mocked(startDueRun).mockRejectedValueOnce(new Error("private-data"));
    const failed = await POST(request());
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private-data");
    expect((await POST(request())).status).toBe(200);
    vi.mocked(prisma.job.count).mockRejectedValue(new Error("private-data"));
    expect((await GET(request())).status).toBe(503);
  });
});
