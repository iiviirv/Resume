import { Container, getContainer } from "@cloudflare/containers";

import { authorized, backupDay, forwardedRequest, INTERNAL_CRON_PATH } from "./routing.ts";

interface Env extends Cloudflare.Env {
  DATABASE_URL: string;
  DIRECT_DATABASE_URL: string;
  DOSSIER_PASSWORD: string;
  DOSSIER_SECRET: string;
  DOSSIER_CRON_SECRET: string;
  DOSSIER_AI_PROVIDER?: string;
  DOSSIER_AI_URL?: string;
  DOSSIER_AI_MODEL?: string;
  DOSSIER_AI_KEY?: string;
  DOSSIER_AI_TIMEOUT_SECONDS?: string;
  DOSSIER_JOBS_SOURCE?: string;
  DOSSIER_JSEARCH_KEY?: string;
  DOSSIER_JSEARCH_HOST?: string;
  DOSSIER_ADZUNA_APP_ID?: string;
  DOSSIER_ADZUNA_KEY?: string;
  DOSSIER_GOOGLE_CLIENT_ID?: string;
  DOSSIER_GOOGLE_CLIENT_SECRET?: string;
  DOSSIER_PUBLIC_URL?: string;
}

const PASSTHROUGH = [
  "DATABASE_URL", "DIRECT_DATABASE_URL", "DOSSIER_PASSWORD", "DOSSIER_SECRET", "DOSSIER_CRON_SECRET", "TZ",
  "DOSSIER_TELEMETRY", "DOSSIER_AI_PROVIDER", "DOSSIER_AI_URL", "DOSSIER_AI_MODEL",
  "DOSSIER_AI_KEY", "DOSSIER_AI_TIMEOUT_SECONDS", "DOSSIER_JOBS_SOURCE",
  "DOSSIER_JSEARCH_KEY", "DOSSIER_JSEARCH_HOST", "DOSSIER_ADZUNA_APP_ID", "DOSSIER_ADZUNA_KEY",
  "DOSSIER_GOOGLE_CLIENT_ID", "DOSSIER_GOOGLE_CLIENT_SECRET", "DOSSIER_PUBLIC_URL",
] as const;

export class DossierContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "2m";
  envVars: Record<string, string> = {
    ...Object.fromEntries(PASSTHROUGH.flatMap((key) => this.env[key] ? [[key, this.env[key]!]] : [])),
    DOSSIER_SCHEDULER: "external",
    DOSSIER_FILE_BACKUPS: "off",
    DOSSIER_DATA_DIR: "/data",
  };

  private scheduleRun?: Promise<void>;

  async runSchedule(): Promise<void> {
    this.scheduleRun ??= this.runScheduleOnce().finally(() => { this.scheduleRun = undefined; });
    await this.scheduleRun;
  }

  private async runScheduleOnce(): Promise<void> {
    const auth = { authorization: `Bearer ${this.env.DOSSIER_CRON_SECRET}` };
    const tick = await this.containerFetch(`http://container${INTERNAL_CRON_PATH}`, { method: "POST", headers: auth });
    if (!tick.ok) throw new Error(`Dossier schedule returned ${tick.status}`);
    await tick.body?.cancel();

    const now = new Date();
    const day = backupDay(now);
    if (day && await this.ctx.storage.get("backupDay") !== day) {
      const backup = await this.containerFetch("http://container/api/internal/backup", { headers: auth });
      if (!backup.ok || !backup.body) throw new Error("Dossier backup failed");
      await this.env.BACKUPS.put(`nightly/${day}.json`, backup.body, {
        httpMetadata: { contentType: "application/json" },
      });
      await this.ctx.storage.put("backupDay", day);
      console.log("Dossier private R2 backup completed");
      const cutoff = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
      let cursor: string | undefined;
      do {
        const page = await this.env.BACKUPS.list({ prefix: "nightly/", cursor });
        const old = page.objects.filter((object) => object.key <= `nightly/${cutoff}.json`).map((object) => object.key);
        if (old.length) await this.env.BACKUPS.delete(old);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
  }

  override async onActivityExpired(): Promise<void> {
    // AI jobs are asynchronous: an idle HTTP connection does not mean that
    // the process has finished. On a status failure, preserve running work.
    try {
      const status = await this.containerFetch(`http://container${INTERNAL_CRON_PATH}`, {
        headers: { authorization: `Bearer ${this.env.DOSSIER_CRON_SECRET}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!status.ok) throw new Error("Status unavailable");
      const body = await status.json() as { busy?: unknown };
      if (body.busy !== false) return;
    } catch {
      console.error("Dossier idle check failed; preserving background work");
      return;
    }
    await this.stop();
  }
}

// A stable name and max_instances=1 keep all requests and ticks on one process.
const instance = (env: Env) => getContainer(env.DOSSIER, "vahid");

async function tick(env: Env): Promise<Response> {
  if (!env.DOSSIER_CRON_SECRET || env.DOSSIER_CRON_SECRET.length < 32) {
    throw new Error("Configure DOSSIER_CRON_SECRET before scheduling");
  }
  await instance(env).runSchedule();
  // Logs contain neither profile data nor credentials.
  console.log("Dossier scheduled tick completed");
  return Response.json({ ok: true }, { headers: { "cache-control": "private, no-store" } });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      if (new URL(request.url).pathname === INTERNAL_CRON_PATH) {
        if (request.method !== "POST" || !await authorized(request, env.DOSSIER_CRON_SECRET)) {
          return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
        }
        // Operator smoke check invokes the same function as scheduled().
        return await tick(env);
      }
      if (new URL(request.url).pathname.startsWith("/api/internal/")) {
        return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
      }
      return await instance(env).fetch(forwardedRequest(request));
    } catch {
      console.error("Dossier container request failed");
      return new Response("Dossier is temporarily unavailable.", {
        status: 503, headers: { "cache-control": "private, no-store", "retry-after": "30" },
      });
    }
  },
  async scheduled(_controller, env): Promise<void> {
    await tick(env);
  },
} satisfies ExportedHandler<Env>;
