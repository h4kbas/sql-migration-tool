# sql-migration-tool

Directive-based SQL migration tool for Postgres. Compiles `// @model`, `// @seed`, `// @migration`, `// @defer`, and `// @include` blocks from SQL source files into runnable migrations. Supports `${ENV_VAR}` substitution from `.env`.

Works with any backend that keeps schema SQL in repo folders and connects via local `psql`.

## Install

```bash
npm install sql-migration-tool
```

https://www.npmjs.com/package/sql-migration-tool

From git:

```bash
npm install github:h4kbas/sql-migration-tool
```

Local path while developing:

```json
{
  "dependencies": {
    "sql-migration-tool": "file:../sql-migration-tool"
  }
}
```

## Project setup

Your project root needs:

```
<project-root>/
  migration.config.json   # schema, database connection, folders
  .env                    # database credentials + ${ENV_VAR} substitution in SQL
  models/
  controllers/
  seeds/
  migrations/             # --save output only
```

### `migration.config.json`

```json
{
  "schema": "public",
  "migrationTable": "migration",
  "schemaRoles": [],
  "postgrestReload": false,
  "database": {
    "host": "127.0.0.1",
    "port": 5432,
    "user": "postgres",
    "password": "postgres",
    "database": "myapp"
  },
  "folders": ["models", "controllers", "seeds"],
  "folderSuborders": {
    "seeds": ["base", "dev"]
  }
}
```

`folderSuborders` runs named subfolders first, then any others alphabetically. Example: `seeds/base/*.sql` before `seeds/dev/*.sql`.

| Field | Default | Meaning |
|-------|---------|---------|
| `schema` | `public` | Postgres schema for bootstrap and migration table |
| `migrationTable` | `migration` | Table name inside `schema` |
| `schemaRoles` | `[]` | Roles that get schema/table/function grants on init |
| `postgrestReload` | `false` | Send `NOTIFY pgrst, 'reload schema'` after commands |
| `database.host` | `127.0.0.1` or `.env POSTGRES_HOST` | Postgres host |
| `database.port` | `5432` or `.env POSTGRES_PORT` | Postgres port |
| `database.user` | `.env POSTGRES_USER` | Postgres user |
| `database.password` | `.env POSTGRES_PASSWORD` | Postgres password |
| `database.database` | `.env POSTGRES_DB` | Postgres database name |
| `exportDir` | `migrations` | Default folder for `--save` / `export` output |

PostgREST example:

```json
{
  "schema": "api",
  "migrationTable": "migration",
  "schemaRoles": ["anon", "authenticated"],
  "postgrestReload": true,
  "database": {
    "host": "127.0.0.1",
    "port": 5433,
    "user": "postgres",
    "password": "postgres",
    "database": "myapp"
  },
  "folders": ["models", "controllers", "seeds"]
}
```

Run commands from project root (or pass `--root`).

### `.env`

Required for commands that connect to the database (`seed`, `migrate:up`, `migrate:down`, and `init` without `--export-only`). Must define:

```
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=myapp
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432

# also used in SQL via ${API_KEY}
API_KEY=dev-secret
```

Optional fallbacks when omitted from `migration.config.json`: `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`.

Any key in `.env` is also available for `${ENV_VAR}` substitution in SQL files (see below). Quoted values are supported.

`init --export-only` does not require database credentials but still reads `.env` for `${ENV_VAR}` substitution.

## Example project

Examples below assume `"schema": "api"` in `migration.config.json` (see PostgREST example).

```
myapp/
  migration.config.json
  .env
  models/
    001_users.sql
    002_posts.sql
  controllers/
    users_view.sql
    posts_rpc.sql
  seeds/
    dev_users.sql
    dev_posts.sql
  migrations/              # --save / export output only
```

`models/001_users.sql`:

```sql
// @model
CREATE TABLE api.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

`models/002_posts.sql`:

```sql
// @include ./shared/extensions.sql

// @model
CREATE TABLE api.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES api.users (id),
  title text NOT NULL,
  body text
);
```

`models/shared/extensions.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

`controllers/users_view.sql`:

```sql
DROP VIEW IF EXISTS api.users_public;
CREATE VIEW api.users_public AS
SELECT id, email, created_at
FROM api.users;
```

`seeds/dev_users.sql` (no directive needed in `seeds/`):

```sql
INSERT INTO api.users (email) VALUES
  ('alice@example.com'),
  ('bob@example.com');
```

`seeds/dev_posts.sql`:

```sql
// @seed
INSERT INTO api.posts (user_id, title, body)
SELECT id, 'Hello', 'First post'
FROM api.users
WHERE email = 'alice@example.com';
```

`models/003_add_note.sql` (later schema change):

```sql
// @migration 20260706120000_add_note_column
ALTER TABLE api.users ADD COLUMN note text;
UPDATE api.users SET note = 'legacy' WHERE note IS NULL;

// @migration:down 20260706120000_add_note_column
ALTER TABLE api.users DROP COLUMN note;
```

`controllers/users_view.sql` (view without `note` first; defer recreates it after column migration):

```sql
DROP VIEW IF EXISTS api.users_public;
CREATE VIEW api.users_public AS
SELECT id, email, created_at
FROM api.users;

// @defer 20260706120000_add_note_column
DROP VIEW IF EXISTS api.users_public;
CREATE VIEW api.users_public AS
SELECT id, email, note, created_at
FROM api.users;
```

One-time data backfills belong in `// @migration`, not `// @defer`.

Typical workflow:

```bash
sql-migrate init --drop          # schema from // @model, views from controllers/
sql-migrate seed                 # seed data
sql-migrate migrate:up           # apply pending // @migration blocks
sql-migrate migrate:down         # roll back latest migration
sql-migrate migrate:down --name 20260706120000_add_note_column
```

Preview compiled SQL without touching the database:

```bash
sql-migrate export init --drop --output migrations/preview_init.sql
sql-migrate export migrate:up --output migrations/preview_up.sql
```

## Commands

```bash
sql-migrate init
sql-migrate init --drop
sql-migrate seed
sql-migrate migrate:up
sql-migrate migrate:down
sql-migrate migrate:down --name 20260706120000_add_note_column
sql-migrate init --save
sql-migrate migrate:up --export-only --output migrations/review_up.sql
sql-migrate export init --drop
sql-migrate export seed --output migrations/preview_seed.sql
```

Export writes a single runnable SQL file (bootstrap + compiled SQL when needed) and skips database execution. Review it, edit it, then run with `psql` yourself or drop `--export-only` to execute.

npm scripts example:

```json
{
  "scripts": {
    "db:init": "sql-migrate init --drop",
    "db:seed": "sql-migrate seed",
    "db:migrate:up": "sql-migrate migrate:up",
    "db:migrate:down": "sql-migrate migrate:down",
    "db:export:up": "sql-migrate export migrate:up --output migrations/preview_up.sql"
  }
}
```

### Options

| Flag | Commands | Effect |
|------|----------|--------|
| `--root <path>` | all | project root (default: cwd) |
| `--drop` | `init` | drop configured schema (`DROP SCHEMA ... CASCADE`) then recreate |
| `--save` | all | write compiled SQL to `exportDir` and still run |
| `--export-only` | all | write compiled SQL and skip database execution |
| `--output <path>` | all | custom export/save file path |
| `--folders a,b,c` | all | override `migration.config.json` folder list |
| `--name <migration>` | `migrate:down` | roll back that migration only |

## Directives

Put directives on their own line: `// @<kind> [name]`

| Directive | Runs on | Meaning |
|-----------|---------|---------|
| *(none, above all `// @`)* | every command | Freestanding SQL |
| `// @model` | `init` only | Baseline schema. Not re-run on seed/migrate. |
| `// @seed` | `seed` only | Seed data |
| `// @migration <name>` | `migrate:up` only | Forward migration |
| `// @migration:down <name>` | `migrate:down` only | Rollback SQL for that migration |
| `// @defer <migration>` | every command | Runs when named migration is applied; skipped until then |
| `// @include <path>` | parse time | Inlines SQL from another file (see below) |

SQL below a directive belongs to that block until the next directive.

`// @include` is not a block directive. It is expanded before directives are parsed.

### Freestanding SQL

Anything before the first `// @` in a file is freestanding. It runs on every command (`init`, `seed`, `migrate:up`, `migrate:down`).

Use in `controllers/` for views, functions, triggers. Always drop first so re-runs are safe:

```sql
DROP FUNCTION IF EXISTS api.current_user_id();
CREATE FUNCTION api.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
```

Same file can mix freestanding SQL and `@migration` blocks:

```sql
DROP VIEW IF EXISTS api.users_public;
CREATE VIEW api.users_public AS SELECT id, email FROM api.users;

// @migration 20260706140000_add_status_column
ALTER TABLE api.users ADD COLUMN status text NOT NULL DEFAULT 'active';

// @migration:down 20260706140000_add_status_column
ALTER TABLE api.users DROP COLUMN status;
```

### `@model` (init only)

- Runs only on `init`.
- Required in `models/` files. SQL in `models/` without a directive is ignored.
- Defines tables, types, indexes on a fresh DB.
- Per file order in `init`: `@model` blocks first, then freestanding SQL in the same file.

Example:

```sql
// @model
CREATE TABLE api.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE INDEX organizations_name_idx ON api.organizations (name);
```

Do not put existing-DB-only changes in `@model`. Use `@migration`.

### `@migration` / `@migration:down`

- `migrate:up` runs pending `// @migration` blocks in file discovery order.
- After each migration runs, tool inserts into `<schema>.<migrationTable>`.
- Already-applied migrations are skipped.
- `migrate:down` runs matching `// @migration:down` SQL and deletes the row from the migration table.
- Without `--name`, `migrate:down` rolls back the most recently applied migration.

Migration names must be unique. Use a timestamp prefix.

Forward + rollback in one file:

```sql
// @migration 20260706120000_add_note_column
ALTER TABLE api.users ADD COLUMN note text;

// @migration:down 20260706120000_add_note_column
ALTER TABLE api.users DROP COLUMN note;
```

Split across files (same migration name):

`models/003_add_note.sql`:

```sql
// @migration 20260706120000_add_note_column
ALTER TABLE api.users ADD COLUMN note text;
```

`models/003_add_note.down.sql`:

```sql
// @migration:down 20260706120000_add_note_column
ALTER TABLE api.users DROP COLUMN note;
```

### `@defer`

`// @defer <migration_name>` makes the next block wait until that migration is in the migration table.

**Important:** defer blocks run on every command (`init`, `seed`, `migrate:up`, `migrate:down`) once dependencies are met, like freestanding SQL. Use only for idempotent SQL (`DROP ... IF EXISTS` + `CREATE`, safe `CREATE OR REPLACE`). One-time changes (backfills, `UPDATE`, `INSERT`) belong in `// @migration`.

View that depends on a column added by a migration:

```sql
// @defer 20260706120000_add_note_column
DROP VIEW IF EXISTS api.users_public;
CREATE VIEW api.users_public AS
SELECT id, email, note, created_at
FROM api.users;
```

Function that references a new column:

```sql
// @defer 20260706120000_add_note_column
DROP FUNCTION IF EXISTS api.user_label(api.users);
CREATE FUNCTION api.user_label(u api.users)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT u.email || coalesce(' (' || u.note || ')', '');
$$;
```

Migration that must run after another migration (the `// @migration` block itself runs once on `migrate:up`):

```sql
// @defer 20260706120000_add_note_column
// @migration 20260706130000_set_note_default
ALTER TABLE api.users ALTER COLUMN note SET DEFAULT 'ok';
```

One-time backfill goes in the migration, not defer:

```sql
// @migration 20260706120000_add_note_column
ALTER TABLE api.users ADD COLUMN note text;
UPDATE api.users SET note = 'legacy' WHERE note IS NULL;

// @migration:down 20260706120000_add_note_column
ALTER TABLE api.users DROP COLUMN note;
```

- SQL is included only after every named dependency migration is in the migration table.
- If dependencies are not applied yet, the block is skipped (no error).
- On `migrate:up`, a `// @migration` block still waits for its `// @defer` dependencies before it runs.
- Multiple `// @defer` lines before one block add multiple dependencies (all must be applied).

### `@include`

Put on its own line: `// @include <path>`. Expanded before directives are parsed.

Share extensions across model files:

`models/001_users.sql`:

```sql
// @include ./shared/extensions.sql

// @model
CREATE TABLE api.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
```

Relative to the current file:

```sql
// @include ./shared/types.sql
// @include ../common/grants.sql
```

From an npm package (resolved to `node_modules/<package>/sql/<path>`):

```sql
// @include my-shared-sql/extensions/uuid.sql
```

Package layout:

```
node_modules/my-shared-sql/
  sql/
    extensions/uuid.sql
```

- Included files are expanded recursively.
- Circular includes fail with an error.
- After expansion, `${ENV_VAR}` substitution runs on the combined content.

### `${ENV_VAR}` substitution

Use `${UPPER_SNAKE_CASE}` placeholders in SQL. Values come from `.env` at compile/run time.

Per-environment seed data:

```sql
// @seed
INSERT INTO api.settings (key, value) VALUES
  ('api_key', '${API_KEY}'),
  ('env', '${APP_ENV}');
```

`.env`:

```
API_KEY=dev-secret
APP_ENV=development
```

- Missing variables become an empty string (SQL-escaped).
- Works inside included files too.
- Useful for secrets or per-environment values without duplicating SQL files.

### Files without directives

- `seeds/` files with no directives are treated as one `// @seed` block.
- `models/` files with no directives are ignored; use explicit `// @model`.
- `controllers/` files with no directives are freestanding only.

## File discovery order

1. Top-level folders from `migration.config.json`: default `models` -> `controllers` -> `seeds`.
2. Inside each folder, subfolders follow `folderSuborders` when set.
3. Within a folder/subfolder, `.sql` files are sorted alphabetically (recursive walk).

## What each command compiles

### `init`

- `@model` blocks (all files, in discovery order)
- then freestanding SQL per file (in discovery order)
- `@defer` blocks whose dependencies are already applied
- does not run `@seed` or `@migration`

### `seed`

- freestanding SQL (all files)
- `@seed` blocks
- `@defer` blocks whose dependencies are applied

### `migrate:up`

- freestanding SQL (all files)
- `@migration` blocks not yet in the migration table
- `@defer` blocks whose dependencies are applied

### `migrate:down`

- freestanding SQL (all files)
- `@defer` blocks whose dependencies are still applied
- `@migration:down` for target migration(s)
- `DELETE FROM <schema>.<migrationTable> WHERE name = ...`

## Migration table

Created automatically before seed/migrate in the configured schema:

```sql
CREATE TABLE IF NOT EXISTS <schema>.<migrationTable> (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

## Notes

- Source of truth is SQL in `models/`, `controllers/`, `seeds/`. Saved files in `migrations/` are debug artifacts.
- Tool runs SQL via local `psql` using `database` config and `.env` fallbacks. Requires `psql` on PATH.
- Logs progress during discover, compile, and execution (file counts, SQL size, timings).
- Optional PostgREST reload when `postgrestReload` is true.
- Package authors can ship reusable SQL under `node_modules/<package>/sql/` for `// @include`.
