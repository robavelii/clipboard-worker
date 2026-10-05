/**
 * What an account's plan allows (decisions §44). Read with the device on
 * every authenticated request (auth.ts), so a route checks a limit without
 * another trip to the database. null: no limit of the plan's own; the
 * Worker's global budgets still apply.
 */

import { DEFAULT_TTL_DAYS, FILE_TTL_DAYS } from "@clipsync/protocol";

export interface Plan {
  name: string;
  maxDevices: number | null;
  textTtlDays: number;
  fileTtlDays: number;
  /** false: text and images only. */
  files: boolean;
  storageBytes: number | null;
  classA: number | null;
  classB: number | null;
}

/** The plan columns, for a query that joins `users u` to `plans p`. */
export const PLAN_COLUMNS = `u.plan AS plan_name, p.name AS plan_found, p.max_devices, p.text_ttl_days,
  p.file_ttl_days, p.files, p.storage_bytes, p.class_a, p.class_b`;

export interface PlanRow {
  plan_name: string;
  plan_found: string | null;
  max_devices: number | null;
  text_ttl_days: number | null;
  file_ttl_days: number | null;
  files: number | null;
  storage_bytes: number | null;
  class_a: number | null;
  class_b: number | null;
}

/**
 * The plan a joined row describes. A plan name with no row is a mistake in
 * the plans table; it is logged and gets no limits of its own, as `unlimited`.
 */
export function planFromRow(row: PlanRow): Plan {
  if (row.plan_found === null) {
    console.error({ msg: "account names a plan that does not exist", plan: row.plan_name });
  }
  return {
    name: row.plan_name,
    maxDevices: row.max_devices,
    textTtlDays: row.text_ttl_days ?? DEFAULT_TTL_DAYS,
    fileTtlDays: row.file_ttl_days ?? FILE_TTL_DAYS,
    files: row.files !== 0,
    storageBytes: row.storage_bytes,
    classA: row.class_a,
    classB: row.class_b,
  };
}
