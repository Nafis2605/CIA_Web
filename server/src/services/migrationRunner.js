// server/src/services/migrationRunner.js
// Applies server/database/migrations/*.sql once each, in filename order.
//
// WHY THIS EXISTS
// There was no runner at all. docker-compose.yml mounts init.sql into
// /docker-entrypoint-initdb.d, which Postgres executes ONLY on an empty data
// directory, and server/database/run-migration.sh is a manual one-file-at-a-time
// psql wrapper. So on any pre-existing volume — i.e. every developer machine
// that has ever run this stack before — a new migration simply never ran.
//
// That is not a theoretical problem. The VR room-scoping work (021-023) adds
// columns that server/src/routes/vr.js binds unconditionally: room_id,
// dataset_sync_key, owner_participant_id, lease_*. On an unmigrated database
// POST /vr/sessions raises 42703 (undefined column), the route's generic catch
// turns it into an opaque 500, and VRExplorationManager._tryRegisterSession
// logs a warning and silently degrades to a local-only session — which looks
// exactly like "VR works but nobody else can see me".
//
// DESIGN
//  * A `schema_migrations` ledger keyed by filename. Applying a file records
//    it; a recorded file is never re-run.
//  * Each file runs inside its own transaction, so a failure leaves no partial
//    migration behind and no ledger row.
//  * Filename order (they are zero-padded and numbered), so dependencies hold.
//  * An advisory lock, so two API replicas starting together cannot both apply
//    the same file.
//  * Failure is FATAL by default. A server running against a schema it was not
//    written for produces exactly the silent, hard-to-trace corruption this
//    module exists to prevent — better to refuse to start.
//
//  * BASELINE ON ADOPTION. The first time this meets a database that already
//    has a schema, the existing files are recorded WITHOUT being replayed --
//    see the long note in runMigrations for why. Only genuinely new files are
//    ever applied after that.

const fs = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("migrations");

/** Directory holding the numbered .sql files. */
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "database", "migrations");

/**
 * Postgres advisory lock id. Arbitrary but must be stable across replicas —
 * two servers starting at once have to contend for the SAME number.
 */
const ADVISORY_LOCK_ID = 4711_0001;

/**
 * Skip the baseline and replay every migration from 001. Only for a database
 * known to be behind — see the BASELINE ON ADOPTION note in runMigrations.
 */
const FORCE_FULL_REPLAY = process.env.MIGRATIONS_NO_BASELINE === "true";

/**
 * Create the ledger if it does not exist yet.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<boolean>} true if the ledger was created by this call
 */
async function ensureLedger(client) {
  const existed = await client.query(`SELECT to_regclass('public.schema_migrations') AS t`);
  const alreadyThere = !!existed.rows[0]?.t;

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  return !alreadyThere;
}

/**
 * Has this database already been built by init.sql (or hand-migrated)?
 *
 * `rooms` rather than `users`: it is created by init.sql and by nothing else,
 * so its presence means the base schema is in place.
 *
 * @param {import('pg').PoolClient} client
 * @returns {Promise<boolean>}
 */
async function schemaAlreadyExists(client) {
  const res = await client.query(`SELECT to_regclass('public.rooms') AS t`);
  return !!res.rows[0]?.t;
}

/**
 * List migration filenames in apply order.
 * @returns {string[]}
 */
function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Apply every migration that has not been recorded yet.
 *
 * @param {import('pg').Pool} pool
 * @param {{fatal?: boolean}} [options] - fatal (default true) rethrows on
 *   failure so the caller can refuse to start.
 * @returns {Promise<{applied: string[], skipped: number}>}
 */
async function runMigrations(pool, { fatal = true } = {}) {
  const files = listMigrationFiles();
  if (files.length === 0) {
    log.debug("No migration files found");
    return { applied: [], skipped: 0 };
  }

  const client = await pool.connect();
  const applied = [];
  let skipped = 0;

  try {
    // Serialize across replicas. Session-scoped, released in the finally.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    const ledgerIsNew = await ensureLedger(client);

    // BASELINE ON ADOPTION.
    //
    // init.sql is kept forward-ported — it already contains every column and
    // index the numbered migrations add — and Postgres runs it on any brand-new
    // data directory. Existing developer databases were migrated by hand. So
    // the first time this runner meets a database that already has a schema,
    // replaying 001..N would at best be a no-op and at worst fail on a
    // migration that was never written to be idempotent, which (failure being
    // fatal) would leave the API unable to start.
    //
    // Instead: record the current files as already applied and run nothing.
    // From then on only genuinely NEW files are applied, which is the case
    // this runner exists for. Set MIGRATIONS_NO_BASELINE=true to force a full
    // replay against a database you know is behind.
    if (ledgerIsNew && !FORCE_FULL_REPLAY && (await schemaAlreadyExists(client))) {
      for (const filename of files) {
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
          [filename]
        );
      }
      log.info(
        `Baselined ${files.length} existing migration(s) against a schema that was ` +
          `already in place; none were replayed`
      );
      return { applied: [], skipped: files.length, baselined: true };
    }

    const done = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map(
        (r) => r.filename
      )
    );

    for (const filename of files) {
      if (done.has(filename)) {
        skipped++;
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
      log.info(`Applying migration ${filename}`);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
          [filename]
        );
        await client.query("COMMIT");
        applied.push(filename);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        log.error(`Migration ${filename} FAILED: ${err.message}`);
        throw err;
      }
    }

    if (applied.length > 0) {
      log.info(`Applied ${applied.length} migration(s); ${skipped} already current`);
    } else {
      log.debug(`Schema is current (${skipped} migration(s) already applied)`);
    }

    return { applied, skipped };
  } catch (err) {
    if (fatal) throw err;
    log.warn(`Migrations did not complete: ${err.message}`);
    return { applied, skipped };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
      .catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations, listMigrationFiles };
