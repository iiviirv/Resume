import { describe, expect, it, vi } from "vitest";

import { cronAuthorized } from "@/lib/cron-auth";
import { buildExport } from "@/lib/data-export";

import { GET } from "./route";

vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: vi.fn() }));
vi.mock("@/lib/data-export", () => ({ buildExport: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/log", () => ({ logServerError: vi.fn() }));

describe("machine-only backup export", () => {
  it("refuses signed-out machine requests before reading any data", async () => {
    vi.mocked(cronAuthorized).mockReturnValue(false);
    expect((await GET(new Request("http://container/api/internal/backup"))).status).toBe(401);
    expect(buildExport).not.toHaveBeenCalled();
  });

  it("provides an uncached export with known length for R2 streaming", async () => {
    vi.mocked(cronAuthorized).mockReturnValue(true);
    vi.mocked(buildExport).mockResolvedValue({ format: "dossier-export", name: "é" } as never);
    const response = await GET(new Request("http://container/api/internal/backup"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  });

  it("keeps private failure details out of the response", async () => {
    vi.mocked(cronAuthorized).mockReturnValue(true);
    vi.mocked(buildExport).mockRejectedValue(new Error("private profile details"));
    const response = await GET(new Request("http://container/api/internal/backup"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private profile details");
  });
});
