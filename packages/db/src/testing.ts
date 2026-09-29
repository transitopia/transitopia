// A scratch database per test file: TEST_DATABASE_URL points at a server (any database on it, e.g.
// …/postgres); each call creates transitopia_test_<random>, migrates it, and drops it afterwards.
// Without TEST_DATABASE_URL, database tests are skipped (see infra/compose.dev.yml to run them).

import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, type Db } from "./connect.ts";
import { migrate } from "./migrate.ts";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestDb {
  db: Db;
  pool: pg.Pool;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const name = `transitopia_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const { db, pool } = createDb(url.toString(), 5);
  await migrate(pool);
  return {
    db,
    pool,
    url: url.toString(),
    async drop() {
      await db.destroy();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}
