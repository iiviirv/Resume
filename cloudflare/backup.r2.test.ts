import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

test("SDK-wrapped backup uploads use a real R2 binding", { timeout: 30_000 }, async (t) => {
  const fixture = await build({
    stdin: {
      resolveDir: path.dirname(fileURLToPath(import.meta.url)),
      sourcefile: "backup-r2-fixture.js",
      contents: `
        import { DossierContainer } from "./worker.ts";

        const RealDate = Date;
        globalThis.Date = class extends RealDate {
          constructor(value) { super(value ?? "2026-10-27T08:00:00Z"); }
          static now() { return new RealDate("2026-10-27T08:00:00Z").getTime(); }
        };

        export default {
          async fetch(request, env) {
            const payload = JSON.stringify({ format: "dossier-export", name: "Renée" });
            const mode = new URL(request.url).searchParams.get("length");
            const bytes = new TextEncoder().encode(payload).length;
            const lengths = { invalid: "unknown", unsafe: "9007199254740992", short: String(bytes - 1), long: String(bytes + 1) };
            const headers = { "content-type": "application/json" };
            if (mode !== "missing") headers["content-length"] = lengths[mode] ?? String(bytes);
            const stored = new Map();
            // Bypass the native Container constructor and simulate only its TCP
            // peer. All response wrapping is the real pinned SDK implementation.
            const container = Object.create(DossierContainer.prototype);
            Object.defineProperties(container, {
              env: { value: { BACKUPS: env.BACKUPS, DOSSIER_CRON_SECRET: "s".repeat(32) } },
              ctx: { value: { storage: {
                async get(key) { return stored.get(key); },
                async put(key, value) { stored.set(key, value); },
              } } },
            });
            container.defaultPort = 3000;
            container.sleepAfter = "2m";
            container.inflightRequests = 0;
            container.state = { async getState() { return { status: "healthy" }; } };
            container.container = {
              running: true,
              getTcpPort() {
                return { async fetch(url) {
                  return url.endsWith("/backup")
                    ? new Response(payload, { headers })
                    : Response.json({ ok: true });
                } };
              },
            };
            try {
              await container.runSchedule();
              const object = await env.BACKUPS.get("nightly/2026-10-27.json");
              return Response.json({
                recorded: stored.get("backupDay"),
                backup: object ? await object.text() : null,
              });
            } catch (error) {
              return Response.json({ error: String(error), recorded: stored.get("backupDay") ?? null }, { status: 500 });
            }
          },
        };
      `,
    },
    bundle: true,
    format: "esm",
    write: false,
    external: ["cloudflare:workers", "node:*"],
    target: "es2022",
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: fixture.outputFiles[0].text,
    compatibilityDate: "2026-10-27",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["BACKUPS"],
  }));
  try {
    await t.test("stores a complete UTF-8 export before recording success", async () => {
      const response = await runtime.dispatchFetch("http://test/backup");
      const result = await response.json() as { recorded: string; backup: string; error?: string };
      assert.equal(response.status, 200, result.error);
      assert.equal(result.recorded, "2026-10-27");
      assert.deepEqual(JSON.parse(result.backup), { format: "dossier-export", name: "Renée" });
    });
    for (const length of ["missing", "invalid", "unsafe", "short", "long"]) {
      await t.test(`rejects ${length} length without recording success`, async () => {
        const response = await runtime.dispatchFetch(`http://test/backup?length=${length}`);
        const result = await response.json() as { recorded: string | null };
        assert.equal(response.status, 500);
        assert.equal(result.recorded, null);
      });
    }
  } finally {
    await runtime.dispose();
  }
});
