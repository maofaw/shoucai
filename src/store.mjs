import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export class MarketStore {
  constructor(filePath) {
    ensureParent(filePath);
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY,
        generated_at_ms INTEGER NOT NULL UNIQUE,
        fetched_at_ms INTEGER NOT NULL,
        recipe_count INTEGER NOT NULL,
        source_status TEXT,
        source_encoding TEXT
      );
      CREATE TABLE IF NOT EXISTS recipes (
        snapshot_id INTEGER NOT NULL,
        recipe_id INTEGER NOT NULL,
        formula_id INTEGER,
        place TEXT NOT NULL,
        required_level INTEGER,
        output_name TEXT NOT NULL,
        output_object_id TEXT,
        period_hours REAL NOT NULL,
        output_count REAL NOT NULL,
        material_cost REAL,
        estimated_revenue REAL,
        estimated_fee REAL,
        estimated_profit REAL,
        fee_rate REAL,
        missing_price_count INTEGER,
        today_max_profit REAL,
        seven_day_max_profit REAL,
        output_price REAL,
        materials_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, recipe_id),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_recipes_history
        ON recipes(recipe_id, snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_recipes_place
        ON recipes(place, snapshot_id);
    `);
  }

  close() {
    this.db.close();
  }

  saveSnapshot(snapshot, metadata) {
    const payloadGenerated = Number(snapshot.generated_at);
    const generatedAtMs = Number.isFinite(payloadGenerated)
      ? payloadGenerated
      : (metadata.generatedAtMs ?? metadata.fetchedAtMs);

    const insertSnapshot = this.db.prepare(`
      INSERT OR IGNORE INTO snapshots
        (generated_at_ms, fetched_at_ms, recipe_count, source_status, source_encoding)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertRecipe = this.db.prepare(`
      INSERT OR REPLACE INTO recipes (
        snapshot_id, recipe_id, formula_id, place, required_level,
        output_name, output_object_id, period_hours, output_count,
        material_cost, estimated_revenue, estimated_fee, estimated_profit,
        fee_rate, missing_price_count, today_max_profit, seven_day_max_profit,
        output_price, materials_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      insertSnapshot.run(
        generatedAtMs,
        metadata.fetchedAtMs,
        snapshot.recipes.length,
        String(snapshot.status ?? ''),
        String(snapshot.encoding ?? '')
      );
      const row = this.db.prepare(
        'SELECT id FROM snapshots WHERE generated_at_ms = ?'
      ).get(generatedAtMs);
      if (!row) throw new Error('无法保存快照索引');

      for (const recipe of snapshot.recipes) {
        insertRecipe.run(
          row.id,
          Number(recipe.id),
          Number(recipe.formula_id) || null,
          String(recipe.place ?? ''),
          Number(recipe.required_level) || null,
          String(recipe.output_display_name || recipe.output_name || ''),
          String(recipe.output_object_id ?? ''),
          Number(recipe.period_hours),
          Number(recipe.per_count ?? 1),
          finiteOrNull(recipe.estimated_material_cost),
          finiteOrNull(recipe.estimated_revenue),
          finiteOrNull(recipe.estimated_fee),
          finiteOrNull(recipe.estimated_profit),
          finiteOrNull(recipe.fee_rate),
          Number(recipe.missing_price_count ?? 0),
          finiteOrNull(recipe.today_max_profit),
          finiteOrNull(recipe.seven_day_max_profit),
          finiteOrNull(recipe.output_current_price),
          JSON.stringify(recipe.materials ?? [])
        );
      }
      this.db.exec('COMMIT;');
      return { snapshotId: row.id, generatedAtMs };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  getRecipeHistory(recipeId, lookbackDays, nowMs = Date.now()) {
    const cutoff = nowMs - lookbackDays * 24 * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT
        s.fetched_at_ms,
        r.material_cost,
        r.estimated_profit,
        r.estimated_revenue,
        r.output_price
      FROM recipes r
      JOIN snapshots s ON s.id = r.snapshot_id
      WHERE r.recipe_id = ? AND s.fetched_at_ms >= ?
      ORDER BY s.fetched_at_ms ASC
    `).all(Number(recipeId), cutoff);
  }
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
