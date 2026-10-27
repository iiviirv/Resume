import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Test our Worker policy with a fake container transport, without starting
// Docker or calling Cloudflare. The SDK itself is checked by tsc and Wrangler.
const sdk = `
export class Container {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  containerFetch(...args) { return this.env.transport(...args); }
  async stop() { this.env.stops += 1; }
}
export function getContainer(binding, name) { return binding.getByName(name); }
`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@cloudflare/containers") return { url: `data:text/javascript,${encodeURIComponent(sdk)}`, shortCircuit: true };
    return next(specifier, context);
  },
});

const { DossierContainer, default: worker } = await import("./worker.ts");

// Node has no FixedLengthStream. Actual size enforcement is tested separately
// in backup.r2.test.ts against workerd, the real SDK, and an R2 binding.
Object.defineProperty(globalThis, "FixedLengthStream", { value: class extends TransformStream {
  constructor(length: number) { super(); void length; }
} });

test("public internal routes fail closed before container access", async () => {
  let called = 0;
  const env = { DOSSIER_CRON_SECRET: "s".repeat(32), DOSSIER: { getByName() { called++; throw new Error("should not run"); } } };
  for (const [path, method, token] of [
    ["/api/internal/cron", "GET", "s".repeat(32)],
    ["/api/internal/cron", "POST", "wrong"],
    ["/api/internal/backup", "GET", "s".repeat(32)],
  ]) {
    const response = await worker.fetch(new Request(`https://dossier.example${path}`, {
      method, headers: { authorization: `Bearer ${token}` },
    }), env as never);
    assert.equal(response.status, 404);
  }
  assert.equal(called, 0);
});

test("manual trigger and scheduled handler use the same named singleton", async () => {
  const names: string[] = [];
  let ticks = 0;
  const env = { DOSSIER_CRON_SECRET: "s".repeat(32), DOSSIER: { getByName(name: string) {
    names.push(name); return { async runSchedule() { ticks++; } };
  } } };
  const response = await worker.fetch(new Request("https://dossier.example/api/internal/cron", {
    method: "POST", headers: { authorization: `Bearer ${env.DOSSIER_CRON_SECRET}` },
  }), env as never);
  assert.equal(response.status, 200);
  await worker.scheduled({} as never, env as never);
  assert.deepEqual(names, ["vahid", "vahid"]);
  assert.equal(ticks, 2);
});

test("idle shutdown preserves unfinished work and status failures", async () => {
  const env = { stops: 0, transport: async () => Response.json({ busy: true }) };
  const container = new DossierContainer({} as never, env as never);
  await container.onActivityExpired();
  assert.equal(env.stops, 0);
  env.transport = async () => new Response(null, { status: 503 });
  await container.onActivityExpired();
  assert.equal(env.stops, 0);
  env.transport = async () => Response.json({ busy: false });
  await container.onActivityExpired();
  assert.equal(env.stops, 1);
});

test("backup completion is recorded only after durable upload succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T08:00:00Z").getTime() });
  const recorded: string[] = [];
  let failUpload = true;
  const env = {
    transport: async (url: string) => url.endsWith("/backup")
      ? new Response('{"format":"dossier-export"}', { headers: { "content-length": "27" } })
      : Response.json({ ok: true }),
    BACKUPS: {
      async put(_key: string, body: ReadableStream) {
        await new Response(body).text();
        if (failUpload) throw new Error("upload failed");
      },
      async list() { return { objects: [], truncated: false }; },
    },
  };
  const ctx = { storage: { async get() { return recorded.at(-1); }, async put(_key: string, value: string) { recorded.push(value); } } };
  const container = new DossierContainer(ctx as never, env as never);
  await assert.rejects(container.runSchedule(), /upload failed/);
  assert.deepEqual(recorded, []);
  failUpload = false;
  await container.runSchedule();
  assert.deepEqual(recorded, ["2026-10-27"]);
});
