# Autospokes

Autospokes is a vehicle-care platform foundation. Phase 1 established the npm
workspaces and responsive product shell. Phase 2 adds PostgreSQL/Prisma
persistence, authentication, role authorization, account isolation, and an
auditable one-time Superadmin bootstrap. Bookings, payments, and other business
workflows are not part of these phases.

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

The API loads `apps\api\.env`; Vite reads `apps\web\.env`. Override a setting
for one PowerShell session by setting `$env:PORT` or `$env:VITE_API_BASE_URL`
before starting the corresponding app.

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

The interface includes placeholder navigation for Owner, Independent Detailer,
Society Vendor, Marketplace Vendor, and Superadmin. Authentication endpoints
are an API foundation only; the UI is not connected to them yet.

## Configuration and safety

Local `.env` files are ignored by Git. Keep credentials and private values out
of `.env.example` files. PostgreSQL is local/self-managed configuration; no
external services or paid integrations are configured.

## CI

GitHub Actions installs from the lockfile and runs the build, lint, and test
commands for pushes and pull requests targeting `main`.
