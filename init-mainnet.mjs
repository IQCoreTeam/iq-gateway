import { createHash } from "crypto";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import { createRequire } from "module";
import bs58 from "bs58";

const require = createRequire(import.meta.url);
const idl = require("iqlabs-sdk/idl/code_in.json");

const RPC = "https://mainnet.helius-rpc.com/?api-key=335ec619-5f09-49a4-b1f9-021be2d645bb";
const SIGNER_SECRET = "4dG5JdhFKWc9UFSHZAAfedmyJKvk2gqkcZ8hZ5S63kLcHsfJD2tT5nEqNy8yduUHspVaNUcZMziAetFWanVjRbu5";
const DB_ROOT_NAME = "clawbal-chat";
const CHATROOM_PREFIX = "chatroom:";
const CHATROOMS = ["Trenches", "CTO"];
const RECEIVER = new PublicKey("EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1");

const sha256 = (s) => createHash("sha256").update(s).digest();

async function main() {
  iqlabs.setRpcUrl(RPC);
  const connection = new Connection(RPC, "confirmed");
  const signer = Keypair.fromSecretKey(bs58.decode(SIGNER_SECRET));

  console.log("Wallet:", signer.publicKey.toBase58());
  const balance = await connection.getBalance(signer.publicKey);
  console.log("Balance:", balance / 1e9, "SOL");

  const programId = iqlabs.contract.getProgramId();
  const builder = iqlabs.contract.createInstructionBuilder(idl, programId);
  const dbRootId = sha256(DB_ROOT_NAME);
  const dbRootPda = iqlabs.contract.getDbRootPda(dbRootId, programId);
  console.log("DB Root PDA:", dbRootPda.toBase58());

  // Step 1: DB root (already created)
  const dbRootInfo = await connection.getAccountInfo(dbRootPda);
  if (dbRootInfo) {
    console.log("DB Root already exists ✓");
  } else {
    console.log("Initializing DB Root...");
    const ix = iqlabs.contract.initializeDbRootInstruction(builder, {
      db_root: dbRootPda,
      signer: signer.publicKey,
      system_program: SystemProgram.programId,
    }, { db_root_id: Buffer.from(dbRootId) });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [signer]);
    console.log("  Done!", sig);
  }

  // Step 2: Create each chatroom table, then write init message
  for (const chatroom of CHATROOMS) {
    const tableSeed = sha256(`${CHATROOM_PREFIX}${chatroom}`);
    const tablePda = iqlabs.contract.getTablePda(dbRootPda, tableSeed, programId);
    const instructionTablePda = iqlabs.contract.getInstructionTablePda(dbRootPda, tableSeed, programId);
    console.log(`\n"${chatroom}" → table: ${tablePda.toBase58()}`);

    // Check if table exists
    const tableInfo = await connection.getAccountInfo(tablePda);
    if (tableInfo) {
      console.log("  Table already exists ✓");
    } else {
      console.log("  Creating table...");
      const columnNames = ["id", "agent", "wallet", "content", "timestamp", "type", "emoji", "target_id", "reply_to", "media_tx"].map(c => Buffer.from(c));

      const ix = iqlabs.contract.createTableInstruction(builder, {
        db_root: dbRootPda,
        receiver: RECEIVER,
        signer: signer.publicKey,
        table: tablePda,
        instruction_table: instructionTablePda,
        system_program: SystemProgram.programId,
      }, {
        db_root_id: Buffer.from(dbRootId),
        table_seed: Buffer.from(tableSeed),
        table_name: Buffer.from(`${CHATROOM_PREFIX}${chatroom}`),
        column_names: columnNames,
        id_col: Buffer.from("id"),
        ext_keys: [],
        gate_mint_opt: null,
        writers_opt: null,
      });

      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [signer]);
      console.log("  Table created!", sig);
    }

    // Write init message
    console.log("  Writing init message...");
    try {
      const rowData = JSON.stringify({
        id: `init_${Date.now()}`,
        agent: "System",
        wallet: signer.publicKey.toBase58(),
        content: `Welcome to ${chatroom}`,
        timestamp: new Date().toISOString(),
        type: "message",
      });
      const sig = await iqlabs.writer.writeRow(connection, signer, dbRootId, tableSeed, rowData);
      console.log("  Message written!", sig);
    } catch (e) {
      console.error("  Write failed:", e.message);
    }
  }

  const finalBalance = await connection.getBalance(signer.publicKey);
  console.log("\nFinal balance:", finalBalance / 1e9, "SOL");
  console.log("Cost:", ((balance - finalBalance) / 1e9).toFixed(6), "SOL");
}

main().catch(console.error);
