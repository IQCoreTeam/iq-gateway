import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import {
  metaRouter,
  imgRouter,
  viewRouter,
  renderRouter,
  healthRouter,
  userRouter,
  tableRouter,
  dataRouter,
  siteRouter,
  snsRouter,
  cacheRouter,
  gateRouter,
  dbrootsRouter,
} from "./routes";
import { startBackfill } from "./backfill";
import { openapiSpec } from "./openapi";
import { serveManifestPath } from "./routes/site";
import { resolveDomainToSig } from "./chain/sns";
import { isReservedGatewayPath, normalizeHost, isSafePath } from "./site-hosts";
import { homeHandler } from "./routes/home";
import { initCacheStore } from "./cache/store";
import type { Context, Next } from "hono";

const GENESIS_HASHES: Record<string, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};
const SWAGGER_ASSETS: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "application/javascript; charset=utf-8",
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
await initCacheStore().catch((e) => {
  console.warn("[cache] cache store initialization failed:", e instanceof Error ? e.message : e);
});

const app = new Hono();

app.use("*", cors());
app.use("*", logger());

app.route("/meta", metaRouter);
app.route("/img", imgRouter);
app.route("/view", viewRouter);
app.route("/render", renderRouter);
app.route("/user", userRouter);
app.route("/table", tableRouter);
app.route("/data", dataRouter);
app.route("/site", siteRouter);
app.route("/sns", snsRouter);
app.route("/cache", cacheRouter);
app.route("/gate", gateRouter);
app.route("/dbroots", dbrootsRouter);

// OpenAPI spec + Swagger UI.
app.get("/openapi.json", (c) => c.json(openapiSpec));
app.get("/docs/assets/:file", async (c) => {
  const file = c.req.param("file");
  const contentType = SWAGGER_ASSETS[file];
  if (!contentType) return c.text("not found", 404);

  const asset = Bun.file(new URL(`../node_modules/swagger-ui-dist/${file}`, import.meta.url));
  if (!(await asset.exists())) return c.text("swagger asset missing", 500);

  return new Response(asset, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});
app.get("/docs", (c) => c.html(`<!doctype html>
<html>
  <head>
    <title>IQ Gateway API</title>
    <link rel="stylesheet" href="/docs/assets/swagger-ui.css">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/assets/swagger-ui-bundle.js"></script>
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

// Host-routed manifest middleware — `*.sol.site` hosts get their content
// from the on-chain SNS resolver. Reserved gateway paths and non-sol-site
// hosts pass through untouched.
app.use("/*", async (c: Context, next: Next) => {
  if (isReservedGatewayPath(c.req.path)) return next();
  const host = normalizeHost(c.req.header("host"));
  if (!host) return next();

  const SOL_SITE = ".sol.site";
  if (!host.endsWith(SOL_SITE)) return next();

  const domain = host.slice(0, -SOL_SITE.length);
  if (!domain) return next();

  const resolved = await resolveDomainToSig(domain);
  if (!resolved) return next();

  if (!isSafePath(c.req.path)) return c.text("bad path", 400);

  // resolved = "<sig>" or "<sig>/<recordPath>". The recordPath is what the
  // user baked into their URL record (e.g. /gameboy.html when the manifest's
  // own indexPath is wrong/default). Treat it as the index when the user
  // hit root.
  const slash = resolved.indexOf("/");
  const sig = slash === -1 ? resolved : resolved.slice(0, slash);
  const recordPath = slash === -1 ? "" : resolved.slice(slash + 1);
  const reqPath = c.req.path;
  const filePath = (reqPath === "/" || reqPath === "") && recordPath
    ? `/${recordPath}`
    : reqPath;

  const response = await serveManifestPath({
    manifestSig: sig,
    filePath,
    spaFallback: true,
    ifNoneMatch: c.req.header("If-None-Match") ?? null,
  });
  if (response.status === 304) return c.body(null, 304);
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  const body = await response.arrayBuffer();
  return c.body(body, response.status as 200, headers);
});

app.get("/", homeHandler);
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT) || 3000;
console.log(`IQ Gateway running on port ${port} [${process.env.SOLANA_CLUSTER}]`);

startBackfill();

export default { port, fetch: app.fetch, idleTimeout: 120 };
