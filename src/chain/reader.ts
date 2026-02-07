import { PublicKey } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import { createHash } from "node:crypto";

iqlabs.setRpcUrl(process.env.SOLANA_RPC_ENDPOINT || "https://mainnet.helius-rpc.com/?api-key=335ec619-5f09-49a4-b1f9-021be2d645bb");

type TableRowOptions = {
  limit?: number;
  before?: string;
  speed?: string;
};

export function generateETag(content: string | Buffer): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
}

export async function readAsset(txSig: string) {
  return iqlabs.reader.readCodeIn(txSig);
}

export async function listUserAssets(userPubkey: string, limit = 20, before?: string) {
  return iqlabs.reader.fetchInventoryTransactions(new PublicKey(userPubkey), limit, before);
}

export async function listUserSessions(userPubkey: string) {
  return iqlabs.reader.getSessionPdaList(userPubkey);
}

export async function readUserState(userPubkey: string) {
  return iqlabs.reader.readUserState(userPubkey);
}

export async function readTableRows(
  tablePda: string,
  options: TableRowOptions = {}
): Promise<Array<Record<string, unknown>>> {
  const { limit = 50, before, speed } = options;
  return iqlabs.reader.readTableRows(tablePda, { limit, before, speed });
}

// Fetch the full signature index for a table PDA.
// Returns signatures newest-first (chain default order).
export async function fetchSignatureIndex(
  tablePda: string,
  maxSignatures = 10000,
): Promise<string[]> {
  return iqlabs.reader.collectSignatures(tablePda, maxSignatures);
}

// Decode specific transactions by signature.
// Returns parsed rows in the same format as readTableRows.
export async function readRowsBySignatures(
  signatures: string[],
  tablePda?: string,
): Promise<Array<Record<string, unknown>>> {
  return iqlabs.reader.readTableRows(tablePda ?? signatures[0], { signatures });
}
