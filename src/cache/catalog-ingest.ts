// Catalog ingest. Turns gateway-known objects (DbRoots, tables, rows) into
// flat catalog entries that the FTS5 index can search.
//
// Three triggers:
//   1. cold-start backfill — on boot, ingest dbroots + tables (fast, no row
//      walk) so the index is non-empty even if no traffic has hit /notify.
//   2. row write hook — table.ts /notify endpoint calls ingestRow() for each
//      newly-injected row, so the index updates in real time.
//   3. periodic refresh — every hour, re-run the dbroot/table backfill so
//      newly-discovered dApps show up.

import { CatalogEntry, upsertCatalogEntries, upsertCatalogEntry } from "./catalog";
import { getCachedDbRoots } from "../routes/dbroots";
import { recoverLegacyDbRootLabel } from "./legacy-dbroot-labels";

// Pull human-readable text out of an arbitrary row payload. Keys are scanned
// in a fixed order so the most likely "title" winds up at the front of the
// joined body; the snippet is the first non-empty value. Unknown fields are
// still appended for full-text recall.
const PRIORITY_KEYS = [
  "title", "sub", "subject", "name", "displayName",
  "com", "comment", "message", "content", "body", "text",
  "filename", "filename_", "ext",
];

interface AnyRow extends Record<string, unknown> {
  __txSignature?: string;
}

function rowText(row: AnyRow): { snippet: string; body: string } {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const k of PRIORITY_KEYS) {
    const v = row[k];
    if (typeof v === "string" && v.trim() && !seen.has(v)) {
      ordered.push(v);
      seen.add(v);
    }
  }
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("__")) continue;
    if (PRIORITY_KEYS.includes(k)) continue;
    if (typeof v === "string" && v.trim() && !seen.has(v)) {
      ordered.push(v);
      seen.add(v);
    } else if (typeof v === "number" || typeof v === "boolean") {
      ordered.push(String(v));
    }
  }

  // metadata field is a JSON string; pull filetype/filename out for breadcrumbs.
  const meta = typeof row.metadata === "string" ? row.metadata : "";
  if (meta) {
    try {
      const parsed = JSON.parse(meta) as Record<string, unknown>;
      for (const k of ["filename", "filetype", "ext"]) {
        const v = parsed[k];
        if (typeof v === "string" && v.trim() && !seen.has(v)) {
          ordered.push(v);
          seen.add(v);
        }
      }
    } catch {}
  }

  const snippet = (ordered[0] ?? "").slice(0, 200);
  const body = ordered.join(" ").slice(0, 4000);
  return { snippet, body };
}

/** Build a catalog entry for a single row in a table. Skips when the row
 *  has no text content at all (pure binary references — they show up via
 *  their parent table entry instead). */
export function rowToEntry(args: {
  row: AnyRow;
  sig: string;
  dbrootLabel: string;
  tableLabel: string;
}): CatalogEntry | null {
  const { snippet, body } = rowText(args.row);
  if (!snippet) return null;
  return {
    kind: "row",
    id: args.sig,
    dbroot: args.dbrootLabel,
    label: `${args.tableLabel || "(table)"} — ${snippet.slice(0, 60)}`,
    snippet,
    body: `${snippet} ${body} ${args.tableLabel} ${args.dbrootLabel}`.trim(),
  };
}

/** Hot path: /notify hook calls this with each freshly-written row. */
export async function ingestRow(args: {
  row: AnyRow;
  sig: string;
  dbrootLabel: string;
  tableLabel: string;
}): Promise<void> {
  const entry = rowToEntry(args);
  if (entry) await upsertCatalogEntry(entry);
}

/** Cold path: enumerate dbroots + tables and stamp them. Fast — one /dbroots
 *  call gives us everything we need. Does not walk rows. */
export async function backfillFromDbRoots(): Promise<{ dbroots: number; tables: number }> {
  const payload = await getCachedDbRoots();
  const entries: CatalogEntry[] = [];
  let tables = 0;

  for (const d of payload.dbroots) {
    // LEGACY: recoverLegacyDbRootLabel returns the raw id when available, or
    // a dictionary-resolved label for legacy hashed DbRoots (pre-2026-04-06).
    // Falls through to short hex only for truly unknown roots.
    const dbrootLabel =
      recoverLegacyDbRootLabel(d.id, d.idHex) ?? d.idHex.slice(0, 16);
    entries.push({
      kind: "dbroot",
      id: d.pda,
      dbroot: dbrootLabel,
      label: dbrootLabel,
      snippet: `DbRoot ${dbrootLabel}`,
      body: `${dbrootLabel} ${d.id ?? ""} ${d.idHex} ${d.creator ?? ""}`,
    });

    for (const seed of [...d.tableSeeds, ...d.globalTableSeeds]) {
      if (!seed.tablePda) continue;
      const tableLabel = seed.label ?? seed.hex.slice(0, 16);
      entries.push({
        kind: "table",
        id: seed.tablePda,
        dbroot: dbrootLabel,
        label: tableLabel,
        snippet: `${dbrootLabel} / ${tableLabel}`,
        body: `${tableLabel} ${seed.label ?? ""} ${seed.hex} ${dbrootLabel}`,
      });
      tables++;
    }
  }

  await upsertCatalogEntries(entries);
  return { dbroots: payload.dbroots.length, tables };
}

let backfillTimer: ReturnType<typeof setInterval> | null = null;

/** Schedule periodic backfill so newly-created DbRoots/tables get indexed
 *  even without /notify traffic. Idempotent. */
export function startCatalogBackfillJob(intervalMs = 60 * 60 * 1000): void {
  if (backfillTimer) return;
  // First pass on boot, after a short delay so the boot path isn't blocked.
  setTimeout(() => {
    backfillFromDbRoots()
      .then((r) => console.log(`[catalog] backfill: ${r.dbroots} dbroots, ${r.tables} tables`))
      .catch((e) => console.warn("[catalog] backfill failed:", e instanceof Error ? e.message : e));
  }, 5_000);
  backfillTimer = setInterval(() => {
    backfillFromDbRoots()
      .then((r) => console.log(`[catalog] refresh: ${r.dbroots} dbroots, ${r.tables} tables`))
      .catch((e) => console.warn("[catalog] refresh failed:", e instanceof Error ? e.message : e));
  }, intervalMs);
}
