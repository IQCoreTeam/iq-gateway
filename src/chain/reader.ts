import { PublicKey } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import { createHash } from "node:crypto";

const { reader } = iqlabs;

export function generateETag(content: string | Buffer): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
}

export async function readAsset(txSig: string) {
  return reader.readCodeIn(txSig);
}

export async function listUserAssets(userPubkey: string, limit = 20, before?: string) {
  return reader.fetchInventoryTransactions(new PublicKey(userPubkey), limit, before);
}

export async function listUserSessions(userPubkey: string) {
  return reader.getSessionPdaList(userPubkey);
}

export async function readUserState(userPubkey: string) {
  return reader.readUserState(userPubkey);
}
