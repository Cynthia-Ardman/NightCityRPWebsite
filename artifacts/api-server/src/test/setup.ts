import { beforeEach, afterAll } from "vitest";
import { pool } from "@workspace/db";
import { truncateAll } from "./testDb";

// Start every test from a clean database.
beforeEach(async () => {
  await truncateAll();
});

// Close the connection pool when a test file finishes so the worker can exit.
afterAll(async () => {
  await pool.end();
});
