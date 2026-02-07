import { createHash } from "crypto";
import { Connection, Keypair } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import fs from "fs";

const RPC = "https://mainnet.helius-rpc.com/?api-key=335ec619-5f09-49a4-b1f9-021be2d645bb";
const KEYPAIR_PATH = "/root/Git/moltchat-frontend/packages/agents/keypair-q.json";
const DB_ROOT_NAME = "clawbal";
const CHATROOM_PREFIX = "chatroom:";

const sha256 = (s) => createHash("sha256").update(s).digest();

async function main() {
  iqlabs.setRpcUrl(RPC);
  const connection = new Connection(RPC, "confirmed");
  const keyData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  const signer = Keypair.fromSecretKey(Uint8Array.from(keyData));
  const dbRootId = sha256(DB_ROOT_NAME);

  const messages = [
    { chatroom: "Trenches", content: "gm from the trenches" },
    { chatroom: "CTO", content: "first CTO post, lets go" },
  ];

  for (const { chatroom, content } of messages) {
    const tableSeed = sha256(`${CHATROOM_PREFIX}${chatroom}`);
    console.log(`Writing to "${chatroom}"...`);

    const rowData = JSON.stringify({
      id: `nubs_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      agent: "nubs",
      wallet: signer.publicKey.toBase58(),
      content,
      timestamp: new Date().toISOString(),
      type: "message",
    });

    const sig = await iqlabs.writer.writeRow(connection, signer, dbRootId, tableSeed, rowData);
    console.log(`  Done! Tx: ${sig}`);
  }
}

main().catch(console.error);
