// Backfill historical IQ Labs transactions using Helius gTFA.
// Single pass: scan program txs, decode everything, cache full content.
// After backfill, all historical data is served from disk — zero RPC needed.

import { isHeliusEnabled, HELIUS_RPC, heliusGetTransactionsForAddress } from "./chain";
import { getDiskCache, setDiskCache } from "./cache";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const PROGRAM_ID = "9KLLchQVJpGkw4jPuUmnvqESdR7mtNCYr3qS4iQLabs";
const BACKFILL_FROM_SLOT = process.env.BACKFILL_FROM_SLOT;
const CHECKPOINT_PATH = join(process.env.CACHE_DIR || "./cache", "backfill-checkpoint.json");

let coder: any = null;
let decode58: (s: string) => Uint8Array;

async function initDecoder() {
  if (coder) return;
  const { BorshInstructionCoder } = await import("@coral-xyz/anchor");
  const { contract } = await import("@iqlabs-official/solana-sdk");
  const bs58 = await import("bs58");
  coder = new BorshInstructionCoder(contract.IQ_IDL as any);
  decode58 = (bs58 as any).decode ?? (bs58 as any).default?.decode;
}

function decodeIqInstruction(ixData: string): { name: string; data: Record<string, any> } | null {
  try {
    return coder.decode(Buffer.from(decode58(ixData)));
  } catch {
    return null;
  }
}

export async function startBackfill() {
  if (!BACKFILL_FROM_SLOT || !isHeliusEnabled() || !HELIUS_RPC) return;

  const fromSlot = parseInt(BACKFILL_FROM_SLOT, 10);
  if (isNaN(fromSlot)) {
    console.warn("[backfill] Invalid BACKFILL_FROM_SLOT:", BACKFILL_FROM_SLOT);
    return;
  }

  // Resume from checkpoint if cache is intact
  let startSlot = fromSlot;
  if (existsSync(CHECKPOINT_PATH)) {
    try {
      const cp = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8"));
      if (cp.lastSlot > fromSlot) {
        // Verify cache DB exists
        const cacheDb = join(process.env.CACHE_DIR || "./cache", "cache.db");
        if (existsSync(cacheDb)) {
          startSlot = cp.lastSlot + 1;
          console.log(`[backfill] Resuming from checkpoint slot ${startSlot} (${cp.totalCached} previously cached)`);
        } else {
          console.log(`[backfill] Checkpoint found but cache DB missing — rescanning from ${fromSlot}`);
          unlinkSync(CHECKPOINT_PATH);
        }
      }
    } catch {}
  }

  console.log(`[backfill] Scanning from slot ${startSlot}`);
  backfill(startSlot).catch((e) => {
    console.error("[backfill] Failed:", e instanceof Error ? e.message : e);
  });
}

async function backfill(fromSlot: number) {
  await initDecoder();

  // Seed pagination token from slot so gTFA starts there (format: "slot:position")
  let paginationToken: string | undefined = fromSlot > 398615411 ? `${fromSlot}:0` : undefined;
  let scanned = 0;
  let cached = 0;
  let skipped = 0;
  let sessions = 0;
  let firstSig = "";
  const startTime = Date.now();

  while (true) {
    const res = await fetch(HELIUS_RPC!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransactionsForAddress",
        params: [PROGRAM_ID, {
          limit: 100,
          transactionDetails: "full",
          sortOrder: "asc",
          ...(paginationToken ? { paginationToken } : {}),
        }],
      }),
    });

    if (!res.ok) {
      console.error(`[backfill] gTFA error: HTTP ${res.status}`);
      break;
    }

    const json = await res.json() as {
      result?: { data?: any[]; paginationToken?: string };
    };

    const data = json.result?.data ?? [];
    if (data.length === 0) break;
    scanned += data.length;

    for (const tx of data) {
      if ((tx.slot as number) < fromSlot) continue;

      const sig = tx.transaction?.signatures?.[0] as string;
      if (!sig) continue;

      const cacheKey = `data:${sig}`;
      const existing = await getDiskCache("meta", cacheKey);
      if (existing) {
        if (!firstSig) firstSig = sig;
        skipped++;
        continue;
      }

      // Decode IQ Labs instructions
      const keys: string[] = tx.transaction?.message?.accountKeys ?? [];
      const ixs = tx.transaction?.message?.instructions ?? [];
      let onChainPath = "";
      let metadata = "";
      let inlineData: string | null = null;

      for (const ix of ixs) {
        if (keys[ix.programIdIndex] !== PROGRAM_ID) continue;
        const decoded = decodeIqInstruction(ix.data);
        if (!decoded) continue;

        if (decoded.name === "user_inventory_code_in" || decoded.name === "db_code_in" ||
            decoded.name === "db_instruction_code_in" || decoded.name === "wallet_connection_code_in" ||
            decoded.name === "user_inventory_code_in_for_free") {
          onChainPath = decoded.data.on_chain_path ?? "";
          metadata = decoded.data.metadata ?? "";

          if (!onChainPath) {
            try {
              const parsed = JSON.parse(metadata);
              inlineData = parsed.data ?? null;
            } catch {}
          }
        }
      }

      // For session files: read all chunks via gTFA on the session PDA
      if (onChainPath && onChainPath.length < 80) {
        try {
          const sessionTxs = await heliusGetTransactionsForAddress(onChainPath);
          const chunkMap = new Map<number, string>();

          for (const stx of sessionTxs) {
            const sKeys: string[] = (stx as any).transaction?.message?.accountKeys ?? [];
            const sIxs = (stx as any).transaction?.message?.instructions ?? [];
            for (const ix of sIxs) {
              if (sKeys[ix.programIdIndex] !== PROGRAM_ID) continue;
              const decoded = decodeIqInstruction(ix.data);
              if (decoded?.name === "post_chunk") {
                chunkMap.set(decoded.data.index, decoded.data.chunk);
              }
            }
          }

          if (chunkMap.size > 0) {
            inlineData = Array.from(chunkMap.entries())
              .sort(([a], [b]) => a - b)
              .map(([, chunk]) => chunk)
              .join("");
            sessions++;
          }
        } catch { /* session read failed, cache metadata only */ }
      }

      // For linked-list files: skip full read (would need sequential walk, not worth blocking backfill)
      // They'll be read on-demand and cached then

      await setDiskCache("meta", cacheKey, Buffer.from(JSON.stringify({
        data: inlineData,
        metadata,
        signature: sig,
      })));
      cached++;
      if (!firstSig) firstSig = sig;
    }

    paginationToken = json.result?.paginationToken;
    const lastSlot = data[data.length - 1]?.slot ?? 0;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[backfill] ${scanned} scanned, ${cached} cached (${sessions} sessions), ${skipped} hit, slot ${lastSlot}, ${elapsed}s`);

    // Save checkpoint after each batch
    try {
      writeFileSync(CHECKPOINT_PATH, JSON.stringify({ lastSlot, totalCached: cached + skipped, firstSig, timestamp: Date.now() }));
    } catch {}

    if (!paginationToken || data.length < 100) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[backfill] Complete: ${scanned} scanned, ${cached} new (${sessions} sessions decoded), ${skipped} already cached, ${elapsed}s`);
}
