import assert from "node:assert/strict";
import { test } from "node:test";

import { authorized, backupDay, forwardedRequest } from "./routing.ts";

test("backups become due at Toronto 03:00 through daylight saving changes", () => {
  assert.equal(backupDay(new Date("2026-10-31T06:59:00Z")), null);
  assert.equal(backupDay(new Date("2026-10-31T07:00:00Z")), "2026-10-31");
  assert.equal(backupDay(new Date("2026-11-01T07:00:00Z")), null);
  assert.equal(backupDay(new Date("2026-11-01T08:00:00Z")), "2026-11-01");
  assert.equal(backupDay(new Date("2026-11-01T22:00:00Z")), "2026-11-01");
});

test("machine credentials fail closed, including missing configuration", async () => {
  const secret = "a".repeat(32);
  const request = (token?: string) => new Request("https://dossier.example/api/internal/cron", {
    headers: token ? { authorization: token } : {},
  });
  assert.equal(await authorized(request(`Bearer ${secret}`), undefined), false);
  assert.equal(await authorized(request("Bearer short"), "short"), false);
  assert.equal(await authorized(request(), secret), false);
  assert.equal(await authorized(request(`Bearer ${"b".repeat(32)}`), secret), false);
  assert.equal(await authorized(request(`Basic ${secret}`), secret), false);
  assert.equal(await authorized(request(`Bearer ${secret}`), secret), true);
});

test("proxy replaces forged forwarding headers and preserves the CSRF origin", async () => {
  const original = new Request("https://dossier.example/api/import", {
    method: "POST", body: "payload",
    headers: {
      "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "spoofed",
      "x-forwarded-host": "evil.example", "x-forwarded-proto": "http",
      forwarded: "host=evil.example", origin: "https://evil.example",
    },
  });
  const request = forwardedRequest(original);
  assert.equal(request.headers.get("x-forwarded-for"), "192.0.2.1");
  assert.equal(request.headers.get("x-forwarded-host"), "dossier.example");
  assert.equal(request.headers.get("host"), "dossier.example");
  assert.equal(request.headers.get("x-forwarded-proto"), "https");
  assert.equal(request.headers.get("forwarded"), null);
  assert.equal(request.headers.get("origin"), "https://evil.example");
  assert.equal(await request.text(), "payload");
});
