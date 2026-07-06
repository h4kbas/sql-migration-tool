# sql-migration-tool

Directive-based SQL migration tool for Postgres. Compiles `// @model`, `// @seed`, `// @migration`, and `// @defer` blocks from SQL source files into runnable migrations.

Works with any backend that keeps schema SQL in repo folders and runs Postgres via Docker Compose.

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
  migration.config.json   # optional folder order
  .env                    # POSTGRES_USER, POSTGRES_DB
  docker-compose.yml      # postgres service named "postgres"
  models/
  controllers/
  seeds/
  migrations/             # --save output only
```

Run commands from project root (or pass `--root`).

## Commands

```bash
sql-migrate init
sql-migrate init --drop
sql-migrate seed
sql-migrate migrate:up
sql-migrate migrate:down
sql-migrate migrate:down --name <migration>
```

npm scripts example:

```json
{
  "scripts": {
    "db:init": "sql-migrate init",
    "db:seed": "sql-migrate seed",
    "db:migrate:up": "sql-migrate migrate:up",
    "db:migrate:down": "sql-migrate migrate:down"
  }
}
```

### Options

| Flag | Commands | Effect |
|------|----------|--------|
| `--root <path>` | all | project root (default: cwd) |
| `--drop` | `init` | `DROP SCHEMA api CASCADE` then recreate |
| `--save` | all | write compiled SQL to `migrations/<timestamp>_<mode>.sql` |
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
| `// @defer <migration>` | `seed`, `migrate:up` | Wait until named migration is applied |

SQL below a directive belongs to that block until the next directive.

### Freestanding SQL

Anything before the first `// @` in a file is freestanding. It runs on every command (`init`, `seed`, `migrate:up`, `migrate:down`).

Use for views, functions, triggers (with `DROP ... IF EXISTS` before `CREATE`).

### `@model` (init only)

- Runs only on `init`.
- Defines tables, types, indexes on a fresh DB.
- Per file order in `init`: `@model` blocks first, then freestanding SQL in the same file.

Do not put existing-DB-only changes in `@model`. Use `@migration`.

### `@migration` / `@migration:down`

- `migrate:up` runs pending `// @migration` blocks in file discovery order.
- After each migration runs, tool inserts into `api.migration`.
- Already-applied migrations are skipped.
- `migrate:down` runs matching `// @migration:down` SQL and deletes the row from `api.migration`.
- Without `--name`, `migrate:down` rolls back the most recently applied migration.

Migration names must be unique. Use a timestamp prefix, e.g. `20260706120000_add_note_column`.

### `@defer`

`// @defer <migration_name>` makes the next block (or inline defer block) wait until `<migration_name>` is in `api.migration`.

```sql
// @defer 20260706120000_add_note_column
UPDATE api.users SET note = 'ok';

// @defer 20260706120000_add_note_column
// @migration 20260706130000_set_note_default
ALTER TABLE api.users ALTER COLUMN note SET DEFAULT 'ok';
```

- On `seed` or `migrate:up`, deferred SQL runs only after its dependency migration is applied.
- If dependency is missing, compile fails: `Unresolved // @defer migration dependencies`.
- Multiple `// @defer` lines before one block add multiple dependencies (all must be applied).

### Files without directives

- `seeds/` files with no directives are treated as one `// @seed` block.
- `models/` and `controllers/` files with no directives are freestanding only.

## File discovery order

1. Top-level folders from `migration.config.json`: default `models` -> `controllers` -> `seeds`.
2. Inside each folder, subfolders follow `folderSuborders` when set.
3. Within a folder/subfolder, `.sql` files are sorted alphabetically (recursive walk).

## What each command compiles

### `init`

- `@model` blocks (all files, in discovery order)
- then freestanding SQL per file (in discovery order)
- does not run `@seed`, `@migration`, or `@defer`

### `seed`

- freestanding SQL (all files)
- `@seed` blocks
- `@defer` blocks whose dependencies are applied

### `migrate:up`

- freestanding SQL (all files)
- `@migration` blocks not yet in `api.migration`
- `@defer` blocks whose dependencies are applied

### `migrate:down`

- freestanding SQL (all files)
- `@migration:down` for target migration(s)
- `DELETE FROM api.migration WHERE name = ...`

## `api.migration` table

```sql
CREATE TABLE IF NOT EXISTS api.migration (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

## Publish

npm: https://www.npmjs.com/~h4kbas

```bash
cd sql-migration-tool
npm login
npm publish
```

GitHub (optional):

```bash
git remote add origin git@github.com:h4kbas/sql-migration-tool.git
git push -u origin master
```

After publish, consumers install with:

```bash
npm install sql-migration-tool
```

Or in `package.json`:

```json
"sql-migration-tool": "^1.0.0"
```

## Notes

- Source of truth is SQL in `models/`, `controllers/`, `seeds/`. Saved files in `migrations/` are debug artifacts.
- Tool runs SQL via `docker compose exec postgres psql` using `.env`.
- Sends `NOTIFY pgrst, 'reload schema'` after each command for PostgREST projects.
