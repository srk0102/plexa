// PostgresAdapter -- persistent storage for VerticalMemory using pg.
// Replaces SQLite for production deployments.
//
// Usage:
//   const vm = new VerticalMemory({
//     spaceName: "my_space",
//     dbAdapter: new PostgresAdapter({ connectionString: "postgres://..." })
//   });
//   await vm.load();  // loads from Postgres
//   await vm.save();  // saves to Postgres

const { Client } = require("pg");

class PostgresAdapter {
  /**
   * @param {object} opts
   * @param {string} [opts.connectionString] - Postgres connection string
   * @param {string} [opts.host]     - default "localhost"
   * @param {number} [opts.port]     - default 54320
   * @param {string} [opts.database] - default "plexa"
   * @param {string} [opts.user]     - default "postgres"
   * @param {string} [opts.password] - default "plexa"
   * @param {string} [opts.table]    - default "vertical_memory"
   */
  constructor(opts = {}) {
    this.table = opts.table || "vertical_memory";
    this._clientOpts = opts.connectionString
      ? { connectionString: opts.connectionString }
      : {
          host: opts.host || "localhost",
          port: opts.port || 54320,
          database: opts.database || "plexa",
          user: opts.user || "postgres",
          password: opts.password || "plexa",
        };
    this._client = null;
  }

  async connect() {
    if (this._client) return;
    this._client = new Client(this._clientOpts);
    await this._client.connect();
    await this._client.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id            INTEGER PRIMARY KEY,
        space_name    TEXT NOT NULL,
        body_name     TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        world_state   JSONB NOT NULL,
        decision      JSONB NOT NULL,
        reasoning     JSONB,
        outcome       BOOLEAN,
        confidence    REAL NOT NULL DEFAULT 0.5,
        source        TEXT,
        session_id    TEXT,
        created_at    BIGINT NOT NULL,
        applied_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0
      )
    `);
    await this._client.query(
      `CREATE INDEX IF NOT EXISTS idx_vm_space ON ${this.table}(space_name)`
    );
  }

  async save(spaceName, entries) {
    await this.connect();
    await this._client.query("BEGIN");
    try {
      await this._client.query(
        `DELETE FROM ${this.table} WHERE space_name = $1`,
        [spaceName]
      );
      for (const e of entries) {
        await this._client.query(
          `INSERT INTO ${this.table}
            (id, space_name, body_name, tool_name, world_state, decision,
             reasoning, outcome, confidence, source, session_id, created_at,
             applied_count, success_count, failure_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            e.id, spaceName, e.bodyName, e.toolName,
            JSON.stringify(e.worldState), JSON.stringify(e.decision),
            e.reasoning ? JSON.stringify(e.reasoning) : null,
            e.outcome == null ? null : e.outcome,
            e.confidence, e.source, e.sessionId, e.createdAt,
            e.appliedCount || 0, e.successCount || 0, e.failureCount || 0,
          ]
        );
      }
      await this._client.query("COMMIT");
      return entries.length;
    } catch (err) {
      await this._client.query("ROLLBACK");
      throw err;
    }
  }

  async load(spaceName) {
    await this.connect();
    const { rows } = await this._client.query(
      `SELECT * FROM ${this.table} WHERE space_name = $1 ORDER BY id ASC`,
      [spaceName]
    );
    return rows.map((row) => ({
      id: row.id,
      spaceName: row.space_name,
      bodyName: row.body_name,
      toolName: row.tool_name,
      worldState: row.world_state || {},
      decision: row.decision,
      reasoning: row.reasoning || null,
      confidence: row.confidence,
      source: row.source,
      sessionId: row.session_id,
      outcome: row.outcome == null ? null : !!row.outcome,
      createdAt: Number(row.created_at),
      appliedCount: row.applied_count || 0,
      successCount: row.success_count || 0,
      failureCount: row.failure_count || 0,
    }));
  }

  async disconnect() {
    if (this._client) {
      await this._client.end();
      this._client = null;
    }
  }
}

module.exports = { PostgresAdapter };
