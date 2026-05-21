import { sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export async function getNextAccountSortOrder(txDb?: typeof db): Promise<number> {
  const queryDb = txDb ?? db;
  const row = await queryDb
    .select({
      maxSortOrder: sql<number>`COALESCE(MAX(${schema.accounts.sortOrder}), -1)`,
    })
    .from(schema.accounts)
    .get();
  return (row?.maxSortOrder ?? -1) + 1;
}
