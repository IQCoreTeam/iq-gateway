import "dotenv/config";
import { Connection, Keypair } from "@solana/web3.js";
import iqlabs from "@iqlabs-official/solana-sdk";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";

const RPC = process.env.SOLANA_RPC_ENDPOINT;
if (!RPC) {
  console.error("SOLANA_RPC_ENDPOINT required");
  process.exit(1);
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css",
  js: "application/javascript", mjs: "application/javascript",
  json: "application/json", txt: "text/plain", xml: "application/xml",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", pdf: "application/pdf", wasm: "application/wasm",
};

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: bun run scripts/deploy-site.ts <folder>");
    process.exit(1);
  }

  const keypairPath = process.argv[3] || process.env.KEYPAIR_PATH || `${homedir()}/.config/solana/id.json`;
  let keypair: Keypair;

  const raw = readFileSync(keypairPath, "utf8").trim();
  if (raw.startsWith("[")) {
    keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  } else {
    // bs58 encoded
    const { decode } = await import("bs58");
    keypair = Keypair.fromSecretKey(decode(raw));
  }

  const connection = new Connection(RPC, "confirmed");
  iqlabs.setRpcUrl(RPC);

  console.log("Wallet:", keypair.publicKey.toBase58());
  const bal = await connection.getBalance(keypair.publicKey);
  console.log("Balance:", (bal / 1e9).toFixed(4), "SOL");

  const allFiles = walk(folder);
  console.log(`\nFound ${allFiles.length} files in ${folder}`);

  const manifest: {
    index?: { path: string };
    paths: Record<string, { id: string }>;
  } = { paths: {} };

  // Upload each file
  for (let i = 0; i < allFiles.length; i++) {
    const fullPath = allFiles[i];
    const relPath = relative(folder, fullPath).replace(/\\/g, "/");
    const data = readFileSync(fullPath);
    const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";

    console.log(`[${i + 1}/${allFiles.length}] ${relPath} (${data.length} bytes, ${mime})`);

    try {
      const txSig = await iqlabs.writer.codeIn(
        { connection, signer: keypair },
        data.toString("base64"),
        relPath,
        0,
        mime,
      );
      manifest.paths[relPath] = { id: txSig };
      console.log(`  → ${txSig.slice(0, 20)}...`);
    } catch (e) {
      console.error(`  FAILED: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }

  // Set index
  if (manifest.paths["index.html"]) {
    manifest.index = { path: "index.html" };
  }

  console.log("\nUploading manifest...");
  const manifestJson = JSON.stringify(manifest);
  console.log(`Manifest: ${manifestJson.length} bytes, ${Object.keys(manifest.paths).length} files`);

  const manifestSig = await iqlabs.writer.codeIn(
    { connection, signer: keypair },
    Buffer.from(manifestJson).toString("base64"),
    "manifest.json",
    0,
    "application/json",
  );

  console.log("\n=== DEPLOYED ===");
  console.log("Manifest TX:", manifestSig);
  console.log("View at: /site/" + manifestSig);
  console.log("\nManifest contents:");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error("Deploy failed:", e);
  process.exit(1);
});
