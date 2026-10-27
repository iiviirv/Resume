import "server-only";

import { timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/** No browser-session fallback: machine access is disabled unless configured. */
export function cronAuthorized(request: Request): boolean {
  const secret = env.DOSSIER_CRON_SECRET;
  if (env.DOSSIER_SCHEDULER !== "external" || !secret || secret.length < 32) return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
