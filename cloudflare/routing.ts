import { timingSafeEqual } from "node:crypto";

export const INTERNAL_CRON_PATH = "/api/internal/cron";

/** A daily backup becomes due at 03:00 Toronto, including after a missed tick. */
export function backupDay(now: Date): string | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return Number(value("hour")) >= 3 ? `${value("year")}-${value("month")}-${value("day")}` : null;
}

/** Constant-time comparison for a fixed-size machine credential in Workers. */
export async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const encode = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(request.headers.get("authorization") ?? "")),
    crypto.subtle.digest("SHA-256", encode.encode(`Bearer ${secret}`)),
  ]);
  return timingSafeEqual(new Uint8Array(actual), new Uint8Array(expected));
}

/** Preserve Origin for Next.js CSRF checks; replace untrusted proxy headers. */
export function forwardedRequest(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("forwarded");
  headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "unknown");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");
  headers.set("host", url.host);
  return new Request(request, { headers });
}
