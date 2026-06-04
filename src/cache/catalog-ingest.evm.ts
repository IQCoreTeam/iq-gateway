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
import { getCachedDbRoots } from "../routes/evm/dbroots";
import { buildEvmWrapper } from "../chain/wrappers";
import { NETWORKS, type NetworkMode } from "../chain/evm/networks";

// Which EVM networks to backfill: locked one (IQ_CHAIN=evm + IQETH_NETWORK) or
// all of them in multi-chain mode.
function backfillNetworks(): NetworkMode[] {
  const all = Object.keys(NETWORKS) as NetworkMode[];
  if (process.env.IQ_CHAIN === "evm") {
    const n = process.env.IQETH_NETWORK as NetworkMode | undefined;
    return n && all.includes(n) ? [n] : all;
  }
  return all;
}

const PRIORITY_KEYS = [
  "title", "sub", "subject", "name", "displayName",
  "com", "comment", "message", "content", "body", "text",
  "filename", "filename_", "ext",
];

interface AnyRow extends Record<string, unknown> {
  __txHash?: string;
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

export function rowToEntry(args: {
  row: AnyRow;
  txHash: string;
  dbrootLabel: string;
  tableLabel: string;
  network?: string;
}): CatalogEntry | null {
  const { snippet, body } = rowText(args.row);
  if (!snippet) return null;
  return {
    kind: "row",
    id: args.txHash,
    network: args.network,
    dbroot: args.dbrootLabel,
    label: `${args.tableLabel || "(table)"} — ${snippet.slice(0, 60)}`,
    snippet,
    body: `${snippet} ${body} ${args.tableLabel} ${args.dbrootLabel}`.trim(),
  };
}

export async function ingestRow(args: {
  row: AnyRow;
  txHash: string;
  dbrootLabel: string;
  tableLabel: string;
  network?: string;
}): Promise<void> {
  const entry = rowToEntry(args);
  if (entry) await upsertCatalogEntry(entry);
}

export async function backfillFromDbRoots(): Promise<{ dbroots: number; tables: number }> {
  const entries: CatalogEntry[] = [];
  let dbrootCount = 0;
  let tables = 0;

  for (const network of backfillNetworks()) {
    const wrapper = buildEvmWrapper(network);
    let payload;
    try {
      payload = await getCachedDbRoots(network, wrapper.getTablelistFromRoot);
    } catch (e) {
      console.warn(`[catalog] backfill ${network} failed:`, e instanceof Error ? e.message : e);
      continue;
    }
    dbrootCount += payload.dbroots.length;

    for (const d of payload.dbroots) {
      const dbrootLabel = d.id || d.seedHex.slice(0, 16);
      entries.push({
        kind: "dbroot",
        id: `${network}:${d.seedHex}`,
        network,
        dbroot: dbrootLabel,
        label: dbrootLabel,
        snippet: `DbRoot ${dbrootLabel}`,
        body: `${dbrootLabel} ${d.id ?? ""} ${d.seedHex} ${d.creator ?? ""}`,
      });

      for (const t of [...d.tables, ...d.globalTables]) {
        entries.push({
          kind: "table",
          id: `${network}:${d.id}:${t.name}`,
          network,
          dbroot: dbrootLabel,
          label: t.name || t.seedHex.slice(0, 16),
          snippet: `${dbrootLabel} / ${t.name}`,
          body: `${t.name} ${t.seedHex} ${dbrootLabel}`,
        });
        tables++;
      }
    }
  }

  await upsertCatalogEntries(entries);
  return { dbroots: dbrootCount, tables };
}

let backfillTimer: ReturnType<typeof setInterval> | null = null;

export function startCatalogBackfillJob(intervalMs = 60 * 60 * 1000): void {
  if (backfillTimer) return;
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
