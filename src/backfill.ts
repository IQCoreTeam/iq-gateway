// Backfill historical IQ Labs transactions using Helius gTFA.
// Two passes:
//   1. Scan all program txs, decode and cache codeIn metadata
//   2. For session/linked-list files, read + cache the full decoded content
// After backfill, all historical data is served from disk — zero RPC needed.

import { isHeliusEnabled, HELIUS_RPC } from "./chain";
import { readAsset, decodeAssetData } from "./chain";
import { getDiskCache, setDiskCache } from "./cache";

const PROGRAM_ID = "9KLLchQVJpGkw4jPuUmnvqESdR7mtNCYr3qS4iQLabs";
const BACKFILL_FROM_SLOT = process.env.BACKFILL_FROM_SLOT;

let coder: any = null;
let decode58: (s: string) => Uint8Array;

async function initDecoder() {
  if (coder) return;
  const { BorshInstructionCoder } = await import("@coral-xyz/anchor");
  const IDL = (await import("@iqlabs-official/solana-sdk/idl/code_in.json")).default;
  const bs58 = await import("bs58");
  coder = new BorshInstructionCoder(IDL as any);
  decode58 = (bs58 as any).decode ?? (bs58 as any).default?.decode;
}

export async function startBackfill() {
  if (!BACKFILL_FROM_SLOT || !isHeliusEnabled() || !HELIUS_RPC) return;

  const fromSlot = parseInt(BACKFILL_FROM_SLOT, 10);
  if (isNaN(fromSlot)) {
    console.warn("[backfill] Invalid BACKFILL_FROM_SLOT:", BACKFILL_FROM_SLOT);
    return;
  }

  console.log(`[backfill] Starting from slot ${fromSlot}`);

  try {
    // Pass 1: scan all txs, cache metadata + inline data
    const pending = await pass1_scanAndCache(fromSlot);

    // Pass 2: for non-inline files, read full content via SDK and cache
    if (pending.length > 0) {
      await pass2_cacheFullContent(pending);
    }
  } catch (e) {
    console.error("[backfill] Failed:", e instanceof Error ? e.message : e);
  }
}

interface PendingFile {
  sig: string;
  onChainPath: string;
  metadata: string;
}

async function pass1_scanAndCache(fromSlot: number): Promise<PendingFile[]> {
  await initDecoder();

  let paginationToken: string | undefined;
  let totalFetched = 0;
  let cached = 0;
  let skipped = 0;
  const pending: PendingFile[] = [];
  const startTime = Date.now();

  console.log("[backfill] Pass 1: scanning program transactions...");

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
    totalFetched += data.length;

    for (const tx of data) {
      if ((tx.slot as number) < fromSlot) continue;

      const sig = tx.transaction?.signatures?.[0] as string;
      if (!sig) continue;

      const cacheKey = `data:${sig}`;
      const existing = await getDiskCache("meta", cacheKey);
      if (existing) {
        skipped++;
        continue;
      }

      // Decode IQ Labs instructions
      const keys: string[] = tx.transaction?.message?.accountKeys ?? [];
      const ixs = tx.transaction?.message?.instructions ?? [];
      let onChainPath = "";
      let metadata = "";
      let inlineData: string | null = null;
      let isCodeIn = false;

      for (const ix of ixs) {
        if (keys[ix.programIdIndex] !== PROGRAM_ID) continue;
        try {
          const decoded = coder.decode(Buffer.from(decode58(ix.data)));
          if (!decoded) continue;

          if (decoded.name === "user_inventory_code_in" || decoded.name === "db_code_in" ||
              decoded.name === "db_instruction_code_in" || decoded.name === "wallet_connection_code_in" ||
              decoded.name === "user_inventory_code_in_for_free") {
            isCodeIn = true;
            onChainPath = decoded.data.on_chain_path ?? "";
            metadata = decoded.data.metadata ?? "";

            if (!onChainPath) {
              try {
                const parsed = JSON.parse(metadata);
                inlineData = parsed.data ?? null;
              } catch {}
            }
          }
        } catch {}
      }

      // Cache metadata + inline data
      await setDiskCache("meta", cacheKey, Buffer.from(JSON.stringify({
        data: inlineData,
        metadata,
        signature: sig,
      })));
      cached++;

      // If non-inline codeIn, queue for pass 2
      if (isCodeIn && onChainPath) {
        pending.push({ sig, onChainPath, metadata });
      }
    }

    paginationToken = json.result?.paginationToken;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const lastSlot = data[data.length - 1]?.slot ?? 0;
    console.log(`[backfill] P1: ${totalFetched} scanned, ${cached} new, ${skipped} hit, slot ${lastSlot}, ${elapsed}s`);

    if (!paginationToken || data.length < 100) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[backfill] Pass 1 complete: ${totalFetched} txs, ${cached} cached, ${pending.length} need full read, ${elapsed}s`);
  return pending;
}

async function pass2_cacheFullContent(pending: PendingFile[]) {
  const startTime = Date.now();
  let done = 0;
  let failed = 0;

  console.log(`[backfill] Pass 2: reading ${pending.length} non-inline files...`);

  for (const file of pending) {
    // Check if already fully cached (data route caches after first read)
    const cacheKey = `data:${file.sig}`;
    const existing = await getDiskCache("meta", cacheKey);
    if (existing) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(existing));
        if (parsed.data) {
          done++;
          continue; // Already has decoded data
        }
      } catch {}
    }

    // Read full content via SDK (uses gTFA internally for sessions)
    try {
      const { data, metadata } = await readAsset(file.sig);
      await setDiskCache("meta", cacheKey, Buffer.from(JSON.stringify({
        data,
        metadata,
        signature: file.sig,
      })));
      done++;
    } catch {
      failed++;
    }

    if ((done + failed) % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[backfill] P2: ${done}/${pending.length} done, ${failed} failed, ${elapsed}s`);
    }

    // Throttle to avoid overwhelming RPC
    await new Promise((r) => setTimeout(r, 100));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[backfill] Pass 2 complete: ${done} cached, ${failed} failed, ${elapsed}s`);
}
