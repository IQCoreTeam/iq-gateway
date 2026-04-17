import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { metaRouter, imgRouter, viewRouter, renderRouter, healthRouter, userRouter, tableRouter, dataRouter, siteRouter, gateRouter } from "./routes";
import { serveSiteAsset } from "./routes/site";
import { startBackfill } from "./backfill";
import { openapiSpec } from "./openapi";
import type { Context, Next } from "hono";

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
    console.warn("Cluster validation failed (non-fatal, RPC may be rate-limited):", e instanceof Error ? e.message : e);
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
app.route("/view", viewRouter);
app.route("/render", renderRouter);
app.route("/user", userRouter);
app.route("/table", tableRouter);
app.route("/data", dataRouter);
app.route("/site", siteRouter);
app.route("/gate", gateRouter);

// OpenAPI spec + Swagger UI — loaded from CDN so no npm dep is needed.
// /openapi.json is the machine-readable schema; /docs renders it interactively.
app.get("/openapi.json", (c) => c.json(openapiSpec));
app.get("/docs", (c) => c.html(`<!doctype html>
<html>
  <head>
    <title>IQ Gateway API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        layout: "BaseLayout",
      });
    </script>
  </body>
</html>`));
app.route("/", healthRouter);

// Serve site assets for root-relative paths (e.g. /blockchan.webp, /_next/...)
app.use("/*", async (c: Context, next: Next) => {
  const result = await serveSiteAsset(c.req.path);
  if (result) {
    const headers: Record<string, string> = {};
    result.headers.forEach((v, k) => { headers[k] = v; });
    const body = await result.arrayBuffer();
    return c.body(body, result.status as 200, headers);
  }
  await next();
});

// Static files
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT) || 3000;
console.log(`IQ Gateway running on port ${port} [${process.env.SOLANA_CLUSTER}]`);

// Background backfill of historical transactions (non-blocking)
startBackfill();

export default { port, fetch: app.fetch, idleTimeout: 120 };
