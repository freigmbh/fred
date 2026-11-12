import { v } from "convex/values";
import type { Doc, TableNames } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { adminAuth, requireAdmin } from "./adminAuth";

// Rows per page. A table gets the light page only when every field is bounded: numbers, IDs, enums, short keys, or strings
// the code caps. Any free text without a cap, from a model, GitLab, upstream errors, or the dashboard, makes the table heavy.
// A heavy page stays under 10 MiB read and returned even at Convex's 1 MiB document limit; light rows are a few KiB at most.
const heavyPage = 10;
const lightPage = 200;

// `false` leaves a table out of the export. Otherwise its page size and the fields never exported: secrets and storage IDs.
type ExportRule<Table extends TableNames> = false | { pageSize: number; omit?: readonly (keyof Doc<Table>)[] };

// Every table's export decision, in schema order. A table added to schema.ts is a type error here until it has one.
const exportTables = {
  modelCatalog: { pageSize: heavyPage },
  settings: { pageSize: lightPage },
  developers: { pageSize: heavyPage }, // blockedReason
  budgets: { pageSize: lightPage },
  projects: { pageSize: lightPage },
  projectTokens: { pageSize: heavyPage, omit: ["sealedToken"] },
  projectPolicies: { pageSize: lightPage },
  reviewJobs: { pageSize: heavyPage, omit: ["leaseToken"] },
  diagnosticSnapshots: { pageSize: heavyPage },
  diagnosticEvents: { pageSize: lightPage }, // eventJson is capped by the diagnosticEvent contract
  transcripts: { pageSize: lightPage, omit: ["storageId"] },
  webhookDeliveries: false,
  usageEvents: { pageSize: lightPage },
  usageDaily: { pageSize: lightPage },
  usageMonthly: { pageSize: lightPage },
  reviewOutcomes: { pageSize: lightPage },
  reviewFailures: { pageSize: heavyPage }, // a denial summary carries blockedReason
  findings: { pageSize: heavyPage },
  findingDecisions: { pageSize: heavyPage }, // reason
  findingCommandRequests: { pageSize: heavyPage },
  findingCommands: { pageSize: heavyPage, omit: ["leaseToken"] },
  mrNotes: { pageSize: heavyPage },
  providerCostSnapshots: { pageSize: lightPage },
  policyAudit: { pageSize: heavyPage }, // before and after
} as const satisfies { [Table in TableNames]: ExportRule<Table> };

// The names exportPage accepts and the manifest lists, in schema order.
type ExportedTable = { [Table in TableNames]: (typeof exportTables)[Table] extends false ? never : Table }[TableNames];
const exportedTables = (Object.keys(exportTables) as TableNames[]).filter((table): table is ExportedTable => exportTables[table] !== false);

// The stored document without its omitted fields. A transcript says whether its file is `available` instead of its storage ID,
// like admin.review; files download one by one through admin.downloadTranscript.
function exportRow(table: ExportedTable, doc: Record<string, unknown>) {
  const rule = exportTables[table];
  const omit: readonly string[] = "omit" in rule ? rule.omit : [];
  const row = Object.fromEntries(Object.entries(doc).filter(([field]) => !omit.includes(field)));
  return table === "transcripts" ? { ...row, available: doc.storageId !== undefined } : row;
}

// The archive format and the exported tables in a stable order, re-exported as admin.exportManifest. The UI reads table names
// from here, never hard-coded.
export const exportManifest = query({
  args: adminAuth,
  handler: (_ctx, args) => {
    requireAdmin(args.adminSecret);
    return { formatVersion: "fred-export/1" as const, tables: exportedTables };
  },
});

// One page of one exported table in creation order, re-exported as admin.exportPage. Start with a null cursor and pass
// continueCursor back until isDone. Rows keep `_id` and `_creationTime` so tables join. Pages are separate reads, so rows
// written or changed between pages show their state at their own page's read.
export const exportPage = query({
  args: { ...adminAuth, table: v.union(...exportedTables.map((table) => v.literal(table))), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const page = await ctx.db.query(args.table).paginate({ cursor: args.cursor, numItems: exportTables[args.table].pageSize });
    return { rows: page.page.map((doc) => exportRow(args.table, doc)), continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
