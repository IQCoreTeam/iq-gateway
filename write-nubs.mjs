import { createHash } from "crypto";
import { Connection, Keypair } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import bs58 from "bs58";

const RPC = "https://mainnet.helius-rpc.com/?api-key=335ec619-5f09-49a4-b1f9-021be2d645bb";
const SIGNER_SECRET = "4dG5JdhFKWc9UFSHZAAfedmyJKvk2gqkcZ8hZ5S63kLcHsfJD2tT5nEqNy8yduUHspVaNUcZMziAetFWanVjRbu5";
const DB_ROOT_NAME = "clawbal-chat";
const CHATROOM_PREFIX = "chatroom:";

const sha256 = (s) => createHash("sha256").update(s).digest();

async function main() {
  iqlabs.setRpcUrl(RPC);
  const connection = new Connection(RPC, "confirmed");
  const signer = Keypair.fromSecretKey(bs58.decode(SIGNER_SECRET));
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
