# Autospokes

Autospokes is a vehicle-care platform foundation. Phase 1 established the npm
workspaces and responsive product shell. Phase 2 adds PostgreSQL/Prisma
persistence, authentication, role authorization, account isolation, and an
auditable one-time Superadmin bootstrap. Phase 3 adds the owner profile and
private vehicle garage. Provider workflows, service bookings, payments, and
other business workflows are not part of these phases.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- PostgreSQL 15 or newer

Check your installation in PowerShell:

```powershell
node --version
npm --version
```

## Windows setup

### 1. Create a dedicated local database

Start the PostgreSQL service installed on your machine and open its `psql`
client as a PostgreSQL administrator. For the standard PostgreSQL 17 Windows
installer:

```powershell
Get-Service postgresql*
Start-Service postgresql-x64-17
& "$env:ProgramFiles\PostgreSQL\17\bin\psql.exe" -U postgres -d postgres
```

Run `Start-Service` from an elevated PowerShell window if the service is stopped;
skip it when the service is already running.

At the `psql` prompt, create a separate application role and database (do not
point this project at an existing application database):

```sql
CREATE ROLE autospokes_app LOGIN;
CREATE DATABASE autospokes_dev OWNER autospokes_app;
\password autospokes_app
\q
```

Enter a unique local password at the `\password` prompts. Do not put that
password in a command, source file, or committed example.

### 2. Configure and install

From the repository root in PowerShell:

```powershell
npm install
if (-not (Test-Path apps\api\.env)) {
  Copy-Item apps\api\.env.example apps\api\.env
  $jwtSecret = node -p "require('node:crypto').randomBytes(48).toString('base64url')"
  $apiEnv = Get-Content apps\api\.env -Raw
  $apiEnv = $apiEnv.Replace("JWT_SECRET=", "JWT_SECRET=$jwtSecret")
  [System.IO.File]::WriteAllText((Resolve-Path apps\api\.env), $apiEnv)
} else {
  Write-Host "Keeping existing apps\api\.env unchanged."
}
if (-not (Test-Path apps\web\.env)) {
  Copy-Item apps\web\.env.example apps\web\.env
} else {
  Write-Host "Keeping existing apps\web\.env unchanged."
}
```

Edit `apps\api\.env` in VS Code and replace the example `DATABASE_URL` password
with the URL-encoded local password chosen above. Keep `.env` files private;
they are ignored by Git. `JWT_SECRET` must remain a random value and must be at
least 32 characters.

### 3. Verify and apply migrations

The guard checks that the URL names a dedicated `autospokes_*` database, opens
the connection, and confirms PostgreSQL reports the exact same database name.
Only then does the migration command run Prisma's non-resetting `migrate deploy`:

```powershell
npm run db:verify
npm run db:migrate
```

The migration command does not reset the database. Do not run it until you have
verified that `DATABASE_URL` points to the dedicated Autospokes database you
created. No database is migrated as part of this foundation unless that
verification is completed explicitly.

### 4. Start the application

```powershell
npm run dev
```

Open the Vite URL printed in the terminal (normally
`http://localhost:5173`). The API health endpoint is
`http://127.0.0.1:3001/health`.

The API loads `apps\api\.env`; Vite reads `apps\web\.env`. In development, Vite
proxies same-origin `/auth` and `/owner` requests to `http://127.0.0.1:3001`.
For one PowerShell session, set `$env:PORT` before starting the API if its port
needs to change; update the proxy target in `apps\web\vite.config.ts` to match.
In a deployment, route those same paths through the hosting reverse proxy to
the API so refresh and CSRF cookies remain same-origin.

## Authentication foundation

- Development-only `POST /auth/register` creates an isolated account for one
  non-Superadmin role. It returns 404 unless `NODE_ENV=development`.
- `POST /auth/login` accepts email/password and an optional assigned role.
- Access tokens are short-lived signed JWTs. Every protected request checks the
  current database session and account/profile context.
- Refresh tokens are opaque, stored only as SHA-256 hashes, rotated on use, and
  sent in `HttpOnly`, `SameSite=Strict` cookies. Refresh/logout require the
  matching CSRF cookie and `x-csrf-token` header.
- Login/register/refresh/logout have per-IP rate limits. Passwords use Argon2id.
- `GET /auth/me`, `GET /accounts/:accountId`, and
  `GET /admin/audit-events` demonstrate session, account-scope, and Superadmin
  authorization boundaries. Superadmins are the only role allowed to read the
  platform audit event list.
- The initial Prisma migration defines users, per-role profiles, isolated
  accounts, refresh sessions, and audit events. It does not create application
  business records.

### One-time Superadmin bootstrap

Set `BOOTSTRAP_SUPERADMIN_EMAIL`, `BOOTSTRAP_SUPERADMIN_PASSWORD` (at least 16
characters), and `BOOTSTRAP_SUPERADMIN_DISPLAY_NAME` in the ignored
`apps\api\.env` file, then run:

```powershell
npm run bootstrap:superadmin
```

The bootstrap requires the database guard, creates no built-in credentials, and
refuses to run if any Superadmin profile already exists. Remove the three
bootstrap values from `.env` after success. In production, set
`ALLOW_PRODUCTION_SUPERADMIN_BOOTSTRAP=true` only for the controlled one-time
bootstrap invocation, using deployment secret management rather than a
committed file.
Also set `NODE_ENV=production` in the deployed API environment; registration is
disabled outside development. After a production bootstrap, remove the
temporary credentials and disable the one-time bootstrap flag.

## Owner app

Sign in from the web UI with an existing Owner account. In development, the
sign-in screen can create an account using the existing `POST /auth/register`
endpoint; the endpoint remains disabled outside `NODE_ENV=development`.
Refresh sessions use the existing HttpOnly refresh cookie and readable CSRF
cookie; short-lived access tokens are kept in memory by the web app.

`GET/PATCH /owner/profile`, `GET/POST /owner/vehicles`, and
`GET/PATCH /owner/vehicles/:vehicleId` require an authenticated Owner role.
Vehicle reads and edits are scoped by the account ID from the
database-validated session, never by registration number. Registration numbers
are compared uppercase with spaces and hyphens removed. A globally unique
database constraint blocks a duplicate across accounts; a conflict returns
only a generic ownership-verification message and never identifies the other
owner. Vehicle registration does not require a provider. Optional provider
details are owner-entered; they are not verified assignments.

The garage supports two-wheelers, four-wheelers, and other vehicles; optional
make/model, dimensions, HTTP(S) photo URLs, location, provider, and status;
profile editing; and a vehicle-specific summary. No service-history,
wash-status, invoice, or balance data source exists yet, so those sections show
no records/unavailable states rather than generated transactions. Photos are
entered as image URLs; direct upload is not available. Independent Detailer,
Society Vendor, Marketplace Vendor, and Superadmin workflows remain out of
scope.

Phase 3 adds the non-destructive migration
`apps\api\prisma\migrations\20261014150000_phase3_owner_vehicles`. It adds
vehicle types, the owner-scoped vehicle table, normalized registration
uniqueness, and dimension/provider consistency constraints. No migration is
run automatically. After configuring and confirming the dedicated database
described above, apply pending migrations with:

```powershell
npm run db:verify
npm run db:migrate
```

## Workspace commands

```powershell
npm run dev
npm run build
npm run lint
npm test
npm run db:verify
npm run db:migrate
```

- `apps/web` — React, TypeScript, Vite, and Tailwind CSS.
- `apps/api` — Node.js, TypeScript, and Fastify.
- `packages/shared` — shared role types and validation schemas.

## Configuration and safety

Local `.env` files are ignored by Git. Keep credentials and private values out
of `.env.example` files. PostgreSQL is local/self-managed configuration; no
external services or paid integrations are configured.

## CI

GitHub Actions installs from the lockfile and runs the build, lint, and test
commands for pushes and pull requests targeting `main`.
