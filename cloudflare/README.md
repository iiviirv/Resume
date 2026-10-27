# Dossier on Cloudflare Containers

A Worker forwards requests to the existing Next.js production image, including
Playwright Chromium. One named Container (`vahid`) and `max_instances: 1` preserve
the app's single-process job queue, PDF downloads, and timers. Do not change the
name or add an instance against the same database. The `basic` instance has
1 GiB memory, matching the existing production Compose memory limit.

## Accounts

Vahid confirmed Workers Paid is already enabled and approved deployment costs.
Run `npx wrangler whoami` from this directory to verify the account. Neon must
use Vahid's personal project. Never create another account or upgrade a plan
without approval. The configured Worker is `dossier`, with a workers.dev URL.

## PostgreSQL and migrations

Keep Prisma 7 with `@prisma/adapter-pg`: the app runs in normal Node.js inside a
Container. Hyperdrive is unnecessary. Use two Neon connection strings:

- `DATABASE_URL`: pooled URL, whose hostname contains `-pooler`, for application
  queries and the idempotent seed.
- `DIRECT_DATABASE_URL`: direct URL, without `-pooler`, for Prisma CLI migrations.

Keep Neon's TLS parameters, including `sslmode=require` and
`channel_binding=require` when supplied. For node-postgres, `sslmode=verify-full`
is an explicit choice that verifies both the certificate and hostname. Do not
use `sslmode=disable`, `sslmode=no-verify`, or `uselibpqcompat=true`. The installed
pg version treats `require` as certificate-verifying TLS too. The runtime and
seed explicitly enable pg's `enableChannelBinding` option so SCRAM-SHA-256-PLUS
is used when the server offers it; the URL parameter alone does not enable that
option in pg. Prisma's migration engine receives the direct URL and its TLS
parameters through `prisma.config.ts`.

Every container start runs `prisma migrate deploy --config prisma.config.ts`,
then the seed, then Next.js. Migration or seed failure stops startup. The first
request after a deployment or sleep can be slow. Never use `migrate dev`, reset,
or the demo seed against production. A Worker rollback does not undo schema
migrations. Review migrations before deployment.

## Secrets

Install the isolated Worker tooling with `npm ci` in this directory. Paste
secret values only into Wrangler's interactive prompts, never chat, command
arguments, build arguments, PRs, logs, or committed files:

```sh
cd /Users/vahidhashemi/.ao/data/worktrees/resume/resume-2/cloudflare
npx wrangler secret put DATABASE_URL --name dossier
npx wrangler secret put DIRECT_DATABASE_URL --name dossier
npx wrangler secret put DOSSIER_PASSWORD --name dossier
```

Paste the pooled Neon URL into `DATABASE_URL` and the direct URL into
`DIRECT_DATABASE_URL`. `DOSSIER_PASSWORD` must be an Argon2id **hash**, never the
actual password. Generate it interactively from the repository root:

```sh
cd /Users/vahidhashemi/.ao/data/worktrees/resume/resume-2
corepack yarn hash-password
```

Run that on Node 24 or later, then return to `cloudflare/` for the secret command.
Keep the actual password privately for signing in. When the Neon CLI has pulled
URLs into an ignored env file, transfer them to Wrangler through stdin with a
script that reads the file, without printing values or putting them in argv.

All required secrets, forwarded to the container at startup:

| Secret | Purpose |
| --- | --- |
| `DATABASE_URL` | Pooled Neon database connection |
| `DIRECT_DATABASE_URL` | Direct Neon migration connection |
| `DOSSIER_PASSWORD` | Argon2id password hash |
| `DOSSIER_SECRET` | Stable random encryption/session key, at least 32 characters |
| `DOSSIER_CRON_SECRET` | Separate random machine-call credential, at least 32 characters |

`DOSSIER_SECRET` and `DOSSIER_CRON_SECRET` were generated directly into Cloudflare
secret storage. For a future installation, set them using `wrangler secret put`
as well. Do not rotate `DOSSIER_SECRET` when recovering the database: stored API
keys depend on it. `wrangler secret list --name dossier` shows names only.

Vahid will enter AI and job-source keys through the signed-in Settings screen.
They are encrypted in PostgreSQL using `DOSSIER_SECRET`; they never need to be
committed or sent to the browser. Choose the provider, URL and model there too.
JSearch needs one key; Adzuna needs its app ID and key. The equivalent optional
Worker secrets are:

```sh
npx wrangler secret put DOSSIER_AI_KEY --name dossier
npx wrangler secret put DOSSIER_JSEARCH_KEY --name dossier
# Only if Adzuna is chosen instead of JSearch:
npx wrangler secret put DOSSIER_ADZUNA_APP_ID --name dossier
npx wrangler secret put DOSSIER_ADZUNA_KEY --name dossier
```

Keep the job agent off until AI and job search have been tested. Non-secret
environment defaults can be added to `vars` in `wrangler.jsonc` if desired.
Optional Gmail setup uses Settings, or `DOSSIER_GOOGLE_CLIENT_SECRET` as another
Worker secret and client ID/public URL as non-secret vars. After changing Worker
secrets, redeploy and verify the Container restarts with the new environment.

## Durable backups and temporary downloads

**Backup choice: private R2 nightly exports, plus Neon's short PITR window.**
File backups are forced off with `DOSSIER_FILE_BACKUPS=off`; `/data` is ephemeral.
The Worker stores one export per Toronto day in the private `dossier-backups`
bucket after 03:00, retaining about 14 days. A missed check is retried on the
next 15-minute tick. Durable Object storage records completion only after R2
confirms the upload. Exports are never exposed through the public Worker.
R2 public URLs and custom domains must remain disabled.

Exports include profile, applications, documents, themes and supported app
settings. They exclude API keys, Google credentials/mail and task data, like the
app's own export feature. Re-enter provider keys and reconnect Google after an
export restore. These exports supplement database recovery, not a full database
dump. Download an export before imports or destructive operations because an
import no longer makes a local file backup. To restore, retrieve a private R2
JSON object using authenticated Cloudflare tools and import it while signed in.
Test restore into an isolated database before replacing important data.
The app's Delete everything action does not purge external R2 exports or Neon
history. Deleted data remains recoverable for those retention windows; purge
R2 objects separately through authenticated Cloudflare tools if required.

Neon Free currently has at most six hours of instant restore, capped at 1 GB of
change history. Confirm that recovery is available in the personal project.
Keep `DOSSIER_SECRET` privately alongside database recovery credentials. Monitor
backup success in Cloudflare logs and the bucket; a failed cron is an error,
not a successful backup. More frequent or longer recovery needs a separate plan.

PostgreSQL holds profile photos and source documents. PDF buffers and ZIP
archives in `/data` can disappear during sleep or deployment. Download promptly,
or generate them again from the documents in PostgreSQL.

## Deploy and scheduling

From `cloudflare/`, with Docker and Buildx available:

```sh
npm ci
npm run types
npm run typecheck
npm test
npx wrangler deploy --dry-run
npm run deploy
```

Wrangler builds the repository-root Dockerfile for `linux/amd64`. Use the
workers.dev URL printed by deployment; preview URLs are disabled. Confirm the
required secrets are set before deploying. Do not disable app sign-in.

Workers Cron Triggers wake the same named Container every 15 minutes. The
machine-only cron endpoint invokes the existing agent due-run check and task
retention sweep. Its local-hour, once-per-day and run-cap rules remain intact.
Concurrent ticks share one check. The external scheduler disables the agent and
backup process timers. Existing inbox and startup refresh timers run only while
the process is awake; continuous overnight polling is not guaranteed.

Before the two-minute idle sleep, the Container checks for queued/running jobs
so asynchronous AI work can finish. A failed status check preserves work and
logs a generic error. Investigate repeated failures because they increase cost.

## Security and required live checks

The Worker overwrites `X-Forwarded-For` with `CF-Connecting-IP`, replaces forwarded
host/protocol headers and preserves Origin for CSRF checks. Existing session,
print-token, cookie and origin checks remain. App responses are streamed.
Machine endpoints independently require a strong configured bearer credential;
there is no browser-session fallback. The public Worker rejects internal routes
except an authenticated POST to `/api/internal/cron` for operator verification.
No request-supplied input selects work or changes settings.

Verify against the deployed URL, not localhost:

1. `/api/health` returns 200 with `db: "ok"` after migrations and seed.
2. `/` redirects to `/login`. Signed-out export, PDF, job, download and private
   print requests are rejected. Wrong-token and missing-token cron POSTs return
   404; internal GET requests also return 404 at the Worker.
3. Sign in with the actual password. Check Secure, HttpOnly, SameSite=Lax session
   cookies. Confirm the dashboard and intended profile without logging fields.
4. Download a PDF through the signed-in UI; verify its signature and readable
   pages. This exercises Playwright Chromium and the internal print-token path.
5. Invoke the authenticated cron POST once. It uses the same function as the
   scheduled handler. Keep its Authorization header in a mode-600 private curl
   config file, not shell history or argv:

   ```sh
   curl --config /private/path/cron.curl --fail-with-body --request POST \
     https://dossier.ACCOUNT.workers.dev/api/internal/cron
   ```

   Expect `{"ok":true}`. Confirm scheduled ticks and the private R2 object after
   03:00 Toronto. Cron changes can take up to 15 minutes to propagate.
6. Confirm at most one running Container. Repeat sign-in/PDF after sleep/wake.

## Cost estimate

As checked on 27 October 2026, Workers Paid starts at USD 5/month and includes
25 GiB-hours of container memory, 375 vCPU-minutes and 200 GB-hours of disk.
Overages are USD 0.009/GiB-hour, USD 0.072/active-vCPU-hour and
USD 0.000252/GB-hour. Memory/disk are provisioned capacity while awake; CPU is
actual active use. Workers and Durable Objects have their own meters.

The 15-minute tick with a two-minute idle window implies about 96 awake hours
per 30-day month, plus startup time. On `basic`, memory/disk overage is about
USD 0.69; fully active CPU throughout those 96 hours would add about USD 1.28.
Budget USD 6 to 10/month for light use, excluding AI/job APIs, other account use
and tax. Always-on basic is about USD 11.93 for the plan plus memory/disk, before
CPU and other meters. This is an estimate, not a spending cap. R2 nightly JSON
exports should fit its free tier for a small personal profile. Monitor usage
and obtain approval before Neon upgrades or added paid services.

References: [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/),
[Neon Prisma guide](https://neon.com/docs/guides/prisma),
[Neon recovery](https://neon.com/docs/introduction/history-window),
[node-postgres TLS](https://node-postgres.com/features/ssl).
