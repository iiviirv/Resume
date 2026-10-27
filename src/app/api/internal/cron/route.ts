import { startDueRun } from "@/lib/agent/schedule";
import { cronAuthorized } from "@/lib/cron-auth";
import { sweepFinishedJobs } from "@/lib/jobs/retention";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "private, no-store" };
const denied = () => Response.json({ error: "Unauthorized" }, { status: 401, headers });

// One app instance, including across development module reloads. Concurrent
// manual and scheduled ticks share a run rather than starting duplicate jobs.
const state = globalThis as unknown as { dossierCron?: Promise<void> };

/** Called by Workers Cron Triggers. No request body or query controls the job. */
export async function POST(request: Request): Promise<Response> {
  if (!cronAuthorized(request)) return denied();
  try {
    state.dossierCron ??= (async () => {
      await sweepFinishedJobs();
      await startDueRun();
    })().finally(() => { state.dossierCron = undefined; });
    await state.dossierCron;
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    logServerError("external schedule", error);
    return Response.json({ error: "Scheduled work failed" }, { status: 500, headers });
  }
}

/** The container's idle hook uses this to avoid interrupting background jobs. */
export async function GET(request: Request): Promise<Response> {
  if (!cronAuthorized(request)) return denied();
  try {
    const activeJobs = await prisma.job.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } });
    return Response.json({ busy: activeJobs > 0 || Boolean(state.dossierCron) }, { headers });
  } catch (error) {
    logServerError("external schedule status", error);
    return Response.json({ error: "Status unavailable" }, { status: 503, headers });
  }
}
