import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { initCacheStore } from "./cache/store";
import { initChain, activeChain } from "./chain";
import type { Context, Next } from "hono";

// One process = one chain, chosen by IQ_CHAIN (default "solana"). The two boot
// paths share cache/queue/server scaffolding but mount their own route set,
// OpenAPI spec, home page, and chain validation. Each branch dynamically
// imports only its own modules so the inactive chain's route code (and its
// timers / resvg load) never runs. See PR #10.
const EVM = activeChain() === "evm";

const SWAGGER_ASSETS: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "application/javascript; charset=utf-8",
};

function mountDocs(app: Hono, openapiSpec: unknown, title: string): void {
  app.get("/openapi.json", (c) => c.json(openapiSpec as Record<string, unknown>));
  app.get("/docs/assets/:file", async (c) => {
    const file = c.req.param("file");
    const contentType = SWAGGER_ASSETS[file];
    if (!contentType) return c.text("not found", 404);
    const asset = Bun.file(new URL(`../node_modules/swagger-ui-dist/${file}`, import.meta.url));
    if (!(await asset.exists())) return c.text("swagger asset missing", 500);
    return new Response(asset, {
      headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" },
    });
  });
  app.get("/docs", (c) => c.html(`<!doctype html>
<html>
  <head>
    <title>${title}</title>
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
}

// Wire the active chain adapter. EVM defers provider/network setup + strict
// IQETH_NETWORK validation into here, so this must run before any RPC use.
initChain();

const app = new Hono();
app.use("*", cors());
app.use("*", logger());

const port = Number(process.env.PORT) || 3000;

if (EVM) {
  // ─── EVM boot path (Sepolia / Monad / Monad Testnet) ───────────────────────
  const { getProvider, NETWORK, NETWORK_CONFIG } = await import("./chain/evm");

  try {
    const net = await getProvider().getNetwork();
    const actual = Number(net.chainId);
    if (actual !== NETWORK_CONFIG.chainId) {
      console.error(`RPC chain mismatch! IQETH_NETWORK=${NETWORK} expects chainId ${NETWORK_CONFIG.chainId} but RPC returned ${actual}`);
      process.exit(1);
    }
    console.log(`Network validated: ${NETWORK} (chainId ${actual})`);
  } catch (e) {
    console.warn("Network validation failed (non-fatal, RPC may be rate-limited):", e instanceof Error ? e.message : e);
  }

  await initCacheStore().catch((e) => {
    console.warn("[cache] init failed:", e instanceof Error ? e.message : e);
  });

  const r = await import("./routes/evm/index");
  // search + admin are chain-agnostic — shared with the Solana boot path.
  const { searchRouter } = await import("./routes/search");
  const { adminRouter, isAdminEnabled } = await import("./routes/admin");
  const { openapiSpec } = await import("./openapi.evm");
  const { homeHandler } = await import("./routes/evm/home");
  const { startCatalogBackfillJob } = await import("./cache/catalog-ingest.evm");

  app.route("/meta", r.metaRouter);
  app.route("/img", r.imgRouter);
  app.route("/view", r.viewRouter);
  app.route("/render", r.renderRouter);
  app.route("/user", r.userRouter);
  app.route("/table", r.tableRouter);
  app.route("/data", r.dataRouter);
  app.route("/ens", r.ensRouter);
  app.route("/cache", r.cacheRouter);
  app.route("/gate", r.gateRouter);
  app.route("/dbroots", r.dbrootsRouter);
  app.route("/search", searchRouter);
  if (isAdminEnabled()) {
    app.route("/admin", adminRouter);
    console.log("[admin] /admin routes enabled (ADMIN_TOKEN set)");
  }

  mountDocs(app, openapiSpec, "IQ Eth Gateway API");
  app.route("/", r.healthRouter);
  app.get("/", homeHandler);
  app.use("/*", serveStatic({ root: "./public" }));

  console.log(`IQ Gateway running on port ${port} [evm:${NETWORK}]`);
  startCatalogBackfillJob();
} else {
  // ─── Solana boot path (devnet / mainnet-beta / testnet) ────────────────────
  const { Connection } = await import("@solana/web3.js");

  const GENESIS_HASHES: Record<string, string> = {
    "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  };

  const cluster = process.env.SOLANA_CLUSTER;
  const rpc = process.env.SOLANA_RPC_ENDPOINT;
  if (!cluster) { console.error("SOLANA_CLUSTER not set (devnet | mainnet-beta | testnet)"); process.exit(1); }
  if (!rpc) { console.error("SOLANA_RPC_ENDPOINT not set"); process.exit(1); }
  const expected = GENESIS_HASHES[cluster];
  if (!expected) { console.error(`Invalid SOLANA_CLUSTER: ${cluster}`); process.exit(1); }
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

  await initCacheStore().catch((e) => {
    console.warn("[cache] cache store initialization failed:", e instanceof Error ? e.message : e);
  });

  const r = await import("./routes/index");
  const { startBackfill } = await import("./backfill");
  const { startCatalogBackfillJob } = await import("./cache/catalog-ingest");
  const { openapiSpec } = await import("./openapi");
  const { serveManifestPath } = await import("./routes/site");
  const { resolveDomainToSig } = await import("./chain/solana/sns");
  const { isReservedGatewayPath, normalizeHost, isSafePath } = await import("./site-hosts");
  const { homeHandler } = await import("./routes/home");

  app.route("/meta", r.metaRouter);
  app.route("/img", r.imgRouter);
  app.route("/view", r.viewRouter);
  app.route("/render", r.renderRouter);
  app.route("/user", r.userRouter);
  app.route("/table", r.tableRouter);
  app.route("/data", r.dataRouter);
  app.route("/site", r.siteRouter);
  app.route("/sns", r.snsRouter);
  app.route("/cache", r.cacheRouter);
  app.route("/gate", r.gateRouter);
  app.route("/dbroots", r.dbrootsRouter);
  app.route("/search", r.searchRouter);
  if (r.isAdminEnabled()) {
    app.route("/admin", r.adminRouter);
    console.log("[admin] /admin routes enabled (ADMIN_TOKEN set)");
  }

  mountDocs(app, openapiSpec, "IQ Gateway API");
  app.route("/", r.healthRouter);

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

  console.log(`IQ Gateway running on port ${port} [${cluster}]`);
  startBackfill();
  startCatalogBackfillJob();
}

export default { port, fetch: app.fetch, idleTimeout: 120 };
