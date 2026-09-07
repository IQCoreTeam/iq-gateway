// eth_getLogs(DbCodeInEvent) backfill — the EVM analogue of Solana's
// getSignaturesForAddress.
//
// The contract emits DbCodeInEvent(dbRootId indexed, tableSeed indexed,
// user indexed, onChainPath, beforeDataTx) on every dbCodeIn and
// dbInstructionCodeIn. Both indexed ids are keccak256 of the utf8 name
// (ethers `id()`), so one filtered scan enumerates every row-write for one
// table in block order — including rows the sequential beforeDataTx pointer
// walk can never reach because the two-tx writeRow race orphaned them.
//
// Scans ascend from the deploy block (IQETH_DEPLOY_BLOCK_<NET>, default 0) in
// adaptive chunks: public RPCs cap getLogs ranges differently per chain, so on
// error the span halves down to a floor. Progress persists per table in
// evm_index_state, so interrupted scans resume instead of restarting, and a
// completed table only scans the new tip on later runs. Everything runs at
// "background" rpc-queue priority so interactive reads are never starved.

import { id as keccakId, type JsonRpcProvider } from "ethers";
import iqlabs from "@iqlabs-official/ethereum-sdk";
import { recordRows, getIndexState, setIndexState, type RowIndexEntry } from "../../cache/row-index";
import { enqueueRpc } from "../rpc-queue";

/** The subset of an EvmWrapper the backfill needs. */
export interface LogIndexSource {
  network: string;
  getProvider(): JsonRpcProvider;
  config: { contractAddress: string };
}

const DEFAULT_SPAN = Number(process.env.IQETH_LOGS_SPAN) || 50_000;
const MIN_SPAN = 1_000;
const MAX_CHUNKS_PER_RUN = 400;
const RETRY_THROTTLE_MS = 5 * 60 * 1000;

function deployBlock(network: string): number {
  const v = process.env[`IQETH_DEPLOY_BLOCK_${network.toUpperCase()}`];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const inflight = new Map<string, Promise<BackfillResult>>();
const lastAttempt = new Map<string, number>();

export interface BackfillResult {
  recorded: number;
  scannedFrom: number;
  scannedTo: number;
  complete: boolean;
}

/** Fire-and-forget trigger for read paths: dedupes concurrent runs and
 *  throttles retries per table. Errors are logged, never thrown. */
export function scheduleTableBackfill(src: LogIndexSource, dbroot: string, tableName: string): void {
  const key = `${src.network}:${dbroot}:${tableName}`;
  if (inflight.has(key)) return;
  const last = lastAttempt.get(key) || 0;
  if (Date.now() - last < RETRY_THROTTLE_MS) return;
  lastAttempt.set(key, Date.now());
  const run = runTableBackfill(src, dbroot, tableName)
    .then((r) => {
      if (r.recorded > 0 || r.complete) {
        console.log(`[log-index] ${key}: +${r.recorded} rows, blocks ${r.scannedFrom}-${r.scannedTo}, complete=${r.complete}`);
      }
      return r;
    })
    .catch((e) => {
      console.warn(`[log-index] ${key} backfill failed:`, e instanceof Error ? e.message : e);
      return { recorded: 0, scannedFrom: 0, scannedTo: 0, complete: false };
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
}

/** Scan DbCodeInEvent logs for one table and record them in the durable row
 *  index. Resumes from persisted state; one run covers at most
 *  MAX_CHUNKS_PER_RUN chunks (later runs continue). */
export async function runTableBackfill(
  src: LogIndexSource, dbroot: string, tableName: string,
): Promise<BackfillResult> {
  const provider = src.getProvider();
  const contract = iqlabs.contract.getContract(provider, src.config.contractAddress);
  const filter = contract.filters.DbCodeInEvent(keccakId(dbroot), keccakId(tableName));

  const latest = await enqueueRpc("background", () => provider.getBlockNumber());
  const state = await getIndexState(src.network, dbroot, tableName);
  const floor = deployBlock(src.network);

  // Resume point: continue an unfinished ascent, or just scan the new tip.
  const from = state ? Math.max(state.syncedToBlock + 1, floor) : floor;
  if (from > latest) {
    return { recorded: 0, scannedFrom: from, scannedTo: latest, complete: state?.complete ?? false };
  }

  let span = DEFAULT_SPAN;
  let cursor = from;
  let recorded = 0;
  let chunks = 0;

  while (cursor <= latest && chunks < MAX_CHUNKS_PER_RUN) {
    const to = Math.min(cursor + span - 1, latest);
    let logs;
    try {
      logs = await enqueueRpc("background", () => contract.queryFilter(filter, cursor, to));
    } catch (e) {
      if (span > MIN_SPAN) {
        span = Math.max(MIN_SPAN, Math.floor(span / 2));
        continue;
      }
      throw e;
    }
    chunks++;

    const entries: RowIndexEntry[] = [];
    for (const log of logs) {
      const args = "args" in log ? log.args : undefined;
      entries.push({
        network: src.network,
        dbroot,
        tableName,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        signer: args ? String(args[2]) : null,
      });
    }
    if (entries.length > 0) {
      await recordRows(entries);
      recorded += entries.length;
    }

    cursor = to + 1;
    await setIndexState(src.network, dbroot, tableName, {
      syncedFromBlock: state?.syncedFromBlock ?? floor,
      syncedToBlock: to,
      complete: to >= latest,
    });
  }

  const complete = cursor > latest;
  return { recorded, scannedFrom: from, scannedTo: cursor - 1, complete };
}
