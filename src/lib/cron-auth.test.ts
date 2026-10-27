import { beforeEach, describe, expect, it, vi } from "vitest";

import { cronAuthorized } from "./cron-auth";

const config = vi.hoisted(() => ({ DOSSIER_SCHEDULER: "external", DOSSIER_CRON_SECRET: "s".repeat(32) as string | undefined }));
vi.mock("@/lib/env", () => ({ env: config }));

beforeEach(() => { config.DOSSIER_SCHEDULER = "external"; config.DOSSIER_CRON_SECRET = "s".repeat(32); });

const request = (authorization?: string) => new Request("http://container/api/internal/cron", { headers: authorization ? { authorization } : {} });

describe("cron authentication", () => {
  it("accepts only the exact configured bearer credential", () => {
    expect(cronAuthorized(request(`Bearer ${config.DOSSIER_CRON_SECRET}`))).toBe(true);
    expect(cronAuthorized(request())).toBe(false);
    expect(cronAuthorized(request(`Bearer ${"x".repeat(32)}`))).toBe(false);
    expect(cronAuthorized(request(`Basic ${config.DOSSIER_CRON_SECRET}`))).toBe(false);
  });

  it("fails closed when not configured, too short, or using process timers", () => {
    config.DOSSIER_CRON_SECRET = undefined;
    expect(cronAuthorized(request("Bearer undefined"))).toBe(false);
    config.DOSSIER_CRON_SECRET = "short";
    expect(cronAuthorized(request("Bearer short"))).toBe(false);
    config.DOSSIER_CRON_SECRET = "s".repeat(32);
    config.DOSSIER_SCHEDULER = "process";
    expect(cronAuthorized(request(`Bearer ${config.DOSSIER_CRON_SECRET}`))).toBe(false);
  });
});
