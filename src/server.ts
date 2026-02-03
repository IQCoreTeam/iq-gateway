import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { metaRouter, imgRouter, healthRouter, userRouter } from "./routes";

const GENESIS_HASHES: Record<string, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};

async function validateCluster() {
  const cluster = process.env.SOLANA_CLUSTER;
  const rpc = process.env.SOLANA_RPC_ENDPOINT;

  if (!cluster) {
    console.error("SOLANA_CLUSTER not set (devnet | mainnet-beta | testnet)");
    process.exit(1);
  }
  if (!rpc) {
    console.error("SOLANA_RPC_ENDPOINT not set");
    process.exit(1);
  }

  const expected = GENESIS_HASHES[cluster];
  if (!expected) {
    console.error(`Invalid SOLANA_CLUSTER: ${cluster}`);
    process.exit(1);
  }

  try {
    const conn = new Connection(rpc);
    const actual = await conn.getGenesisHash();
    if (actual !== expected) {
      console.error(`RPC cluster mismatch! SOLANA_CLUSTER=${cluster} but RPC returned genesis hash for a different network`);
      console.error(`Expected: ${expected}`);
      console.error(`Got: ${actual}`);
      process.exit(1);
    }
    console.log(`Cluster validated: ${cluster}`);
  } catch (e) {
    console.error("Failed to validate cluster:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

await validateCluster();

const app = new Hono();

// Middleware
app.use("*", cors());
app.use("*", logger());

// Routes
app.route("/meta", metaRouter);
app.route("/img", imgRouter);
app.route("/user", userRouter);
app.route("/", healthRouter);

// Static files
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT) || 3000;
console.log(`IQ Gateway running on port ${port} [${process.env.SOLANA_CLUSTER}]`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
