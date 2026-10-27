import { cronAuthorized } from "@/lib/cron-auth";
import { buildExport } from "@/lib/data-export";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Machine-only export for private R2 backups. API keys are excluded. */
export async function GET(request: Request): Promise<Response> {
  const headers = { "cache-control": "private, no-store" };
  if (!cronAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  try {
    const body = JSON.stringify(await buildExport(prisma));
    return new Response(body, { headers: {
      ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
    } });
  } catch (error) {
    logServerError("external backup", error);
    return Response.json({ error: "Backup unavailable" }, { status: 503, headers });
  }
}
