import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { initCacheStore } from "./cache/store";
import { initChain } from "./chain";
import type { Context, Next } from "hono";
import type { EvmWrapper } from "./chain/wrappers";

// Three boot modes, chosen by IQ_CHAIN:
//   - "solana"          → locked single-chain Solana (legacy path, untouched)
//   - "evm"             → locked single-chain EVM    (legacy path, untouched)
//   - unset | "multi"   → MULTI: one process serves Solana + every EVM network,
//                         chain picked per request by the resolver (id shape /
//                         ?network). See PR #11 thread.
const MODE: "solana" | "evm" | "multi" =
  process.env.IQ_CHAIN === "solana" ? "solana" :
  process.env.IQ_CHAIN === "evm" ? "evm" : "multi";

const SWAGGER_ASSETS: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "application/javascript; charset=utf-8",
};

function mountDocs(app: Hono<any>, openapiSpec: unknown, title: string): void {
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

// Wire the active chain adapter for the locked single-chain paths. In multi mode
// each wrapper self-initialises, so this is a no-op (activeChain() → solana).
initChain();

const app = new Hono<{ Variables: { chain?: EvmWrapper; network?: string } }>();
app.use("*", cors());
app.use("*", logger());

const port = Number(process.env.PORT) || 3000;

if (MODE === "evm") {
  // ─── EVM boot path (locked single network) ─────────────────────────────────
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
  const { searchRouter } = await import("./routes/search");
  const { adminRouter, isAdminEnabled } = await import("./routes/admin");
  const { openapiSpec } = await import("./openapi.evm");
  const { homeHandler } = await import("./routes/home");
  const { startCatalogBackfillJob } = await import("./cache/catalog-ingest.evm");

  // Locked EVM: inject the default-network wrapper so the ctx.chain handlers work.
  const { buildEvmWrapper } = await import("./chain/wrappers");
  const wrapper = buildEvmWrapper(NETWORK);
  app.use("*", async (c, next) => { c.set("chain", wrapper); c.set("network", NETWORK); await next(); });

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
} else if (MODE === "solana") {
  // ─── Solana boot path (locked single cluster) ──────────────────────────────
  await bootSolana(app);
  app.use("/*", serveStatic({ root: "./public" }));
} else {
  // ─── MULTI boot path — Solana + every EVM network in one process ───────────
  const { buildWrappers } = await import("./chain/wrappers");
  const { resolveChain, extractId } = await import("./resolver");
  const { NETWORKS } = await import("./chain/evm/networks");

  const wrappers = buildWrappers();
  const networks = Object.keys(wrappers);
  console.log(`[multi] serving chains: ${networks.join(", ")}`);

  // Best-effort validate each EVM network's RPC chainId (non-fatal).
  for (const net of Object.keys(NETWORKS)) {
    const w = wrappers[net] as EvmWrapper | undefined;
    if (!w) continue;
    w.getProvider().getNetwork()
      .then((n) => {
        const actual = Number(n.chainId);
        if (actual !== w.config.chainId) {
          console.warn(`[multi] ${net} RPC chainId ${actual} != expected ${w.config.chainId}`);
        } else {
          console.log(`[multi] ${net} validated (chainId ${actual})`);
        }
      })
      .catch((e) => console.warn(`[multi] ${net} validation skipped:`, e instanceof Error ? e.message : e));
  }

  await initCacheStore().catch((e) => {
    console.warn("[cache] init failed:", e instanceof Error ? e.message : e);
  });

  // Solana sub-app (existing routes, untouched — module-level chain). Built only
  // if a Solana wrapper is present (always, unless IQ_CHAIN locks it out).
  const solApp = new Hono();
  if (wrappers.solana) await bootSolana(solApp);

  // EVM sub-app (ctx.chain handlers). The dispatcher passes the per-request
  // wrapper + network via fetch env; this middleware moves them onto ctx vars.
  type EvmFetchEnv = { Bindings: { chain: EvmWrapper; network: string }; Variables: { chain: EvmWrapper; network: string } };
  const evmApp = new Hono<EvmFetchEnv>();
  evmApp.use("*", async (c, next) => {
    c.set("chain", c.env.chain);
    c.set("network", c.env.network);
    await next();
  });
  {
    const r = await import("./routes/evm/index");
    evmApp.route("/meta", r.metaRouter);
    evmApp.route("/img", r.imgRouter);
    evmApp.route("/view", r.viewRouter);
    evmApp.route("/render", r.renderRouter);
    evmApp.route("/user", r.userRouter);
    evmApp.route("/table", r.tableRouter);
    evmApp.route("/data", r.dataRouter);
    evmApp.route("/ens", r.ensRouter);
    evmApp.route("/gate", r.gateRouter);
    evmApp.route("/dbroots", r.dbrootsRouter);
  }

  // Shared / chain-agnostic routes on the top app (matched before the catch-all).
  const { cacheRouter } = await import("./routes/cache-snapshot");
  const { searchRouter } = await import("./routes/search");
  const { adminRouter, isAdminEnabled } = await import("./routes/admin");
  const { openapiSpec } = await import("./openapi");
  app.route("/cache", cacheRouter);
  app.route("/search", searchRouter);
  if (isAdminEnabled()) {
    app.route("/admin", adminRouter);
    console.log("[admin] /admin routes enabled (ADMIN_TOKEN set)");
  }
  mountDocs(app, openapiSpec, "IQ Gateway API (multi-chain)");

  app.get("/health", async (c) => {
    const { getStats } = await import("./cache/store");
    const disk = await getStats().catch(() => null);
    return c.json({
      status: "ok",
      mode: "multi",
      chains: networks,
      cache: disk ? { entries: disk.entryCount, totalSize: disk.totalSize } : null,
    });
  });
  app.get("/version", async (c) => {
    const pkg = await import("../package.json");
    return c.json({ version: process.env.VERSION || (pkg as { version: string }).version });
  });
  {
    const { homeHandler } = await import("./routes/home");
    app.get("/", homeHandler);
  }

  // Chain-specific route prefixes route by PATH, not id shape — their path
  // segment is a name/domain, not a chain id (e.g. /sns/nubs, /ens/vitalik.eth).
  const SOLANA_ONLY = ["/sns", "/site"];
  const EVM_ONLY = ["/ens"];
  const startsWithAny = (p: string, prefixes: string[]) =>
    prefixes.some((x) => p === x || p.startsWith(x + "/"));

  // Dispatcher: resolve per request → forward to the right sub-app.
  app.all("/*", async (c) => {
    const path = c.req.path;

    if (startsWithAny(path, SOLANA_ONLY)) {
      if (!wrappers.solana) return c.json({ error: "solana not configured on this gateway" }, 503);
      return solApp.fetch(c.req.raw);
    }
    if (startsWithAny(path, EVM_ONLY)) {
      // EVM-only prefix: default to the EVM default network ("0x" sentinel forces
      // it), ?network may override to an L2.
      const resolved = resolveChain("0x", c.req.query("network"));
      const network = "error" in resolved ? null : resolved.chain === "evm" ? resolved.network : null;
      const wrapper = network ? (wrappers[network] as EvmWrapper | undefined) : undefined;
      if (!wrapper) return c.json({ error: "evm not configured on this gateway" }, 503);
      return evmApp.fetch(c.req.raw, { chain: wrapper, network });
    }

    const resolved = resolveChain(extractId(path), c.req.query("network"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    const wrapper = wrappers[resolved.network];
    if (!wrapper) return c.json({ error: `network "${resolved.network}" not configured on this gateway` }, 503);
    if (resolved.chain === "solana") return solApp.fetch(c.req.raw);
    return evmApp.fetch(c.req.raw, { chain: wrapper as EvmWrapper, network: resolved.network });
  });

  app.use("/*", serveStatic({ root: "./public" }));

  // Background catalog backfill for whichever chains are active.
  if (wrappers.solana) {
    const { startCatalogBackfillJob } = await import("./cache/catalog-ingest");
    const { startBackfill } = await import("./backfill");
    startCatalogBackfillJob();
    startBackfill();
  }
  if (networks.some((n) => n !== "solana")) {
    const { startCatalogBackfillJob } = await import("./cache/catalog-ingest.evm");
    startCatalogBackfillJob();
  }

  console.log(`IQ Gateway running on port ${port} [multi: ${networks.join(",")}]`);
}

// ─── Solana mount helper (shared by locked-solana + multi) ───────────────────

async function bootSolana(target: Hono<any>): Promise<void> {
  const { Connection } = await import("@solana/web3.js");

  const GENESIS_HASHES: Record<string, string> = {
    "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  };

  const cluster = process.env.SOLANA_CLUSTER;
  const rpc = process.env.SOLANA_RPC_ENDPOINT;
  if (MODE === "solana") {
    if (!cluster) { console.error("SOLANA_CLUSTER not set (devnet | mainnet-beta | testnet)"); process.exit(1); }
    if (!rpc) { console.error("SOLANA_RPC_ENDPOINT not set"); process.exit(1); }
    const expected = GENESIS_HASHES[cluster];
    if (!expected) { console.error(`Invalid SOLANA_CLUSTER: ${cluster}`); process.exit(1); }
    try {
      const conn = new Connection(rpc);
      const actual = await conn.getGenesisHash();
      if (actual !== expected) {
        console.error(`RPC cluster mismatch! SOLANA_CLUSTER=${cluster} but RPC returned genesis hash for a different network`);
        process.exit(1);
      }
      console.log(`Cluster validated: ${cluster}`);
    } catch (e) {
      console.warn("Cluster validation failed (non-fatal, RPC may be rate-limited):", e instanceof Error ? e.message : e);
    }
    await initCacheStore().catch((e) => {
      console.warn("[cache] cache store initialization failed:", e instanceof Error ? e.message : e);
    });
  }

  const r = await import("./routes/index");
  const { serveManifestPath } = await import("./routes/site");
  const { resolveDomainToSig } = await import("./chain/solana/sns");
  const { isReservedGatewayPath, normalizeHost, isSafePath } = await import("./site-hosts");

  target.route("/meta", r.metaRouter);
  target.route("/img", r.imgRouter);
  target.route("/view", r.viewRouter);
  target.route("/render", r.renderRouter);
  target.route("/user", r.userRouter);
  target.route("/table", r.tableRouter);
  target.route("/data", r.dataRouter);
  target.route("/site", r.siteRouter);
  target.route("/sns", r.snsRouter);
  target.route("/gate", r.gateRouter);
  target.route("/dbroots", r.dbrootsRouter);

  if (MODE === "solana") {
    const { openapiSpec } = await import("./openapi");
    const { homeHandler } = await import("./routes/home");
    const { searchRouter } = await import("./routes/search");
    target.route("/cache", r.cacheRouter);
    target.route("/search", searchRouter);
    if (r.isAdminEnabled()) {
      target.route("/admin", r.adminRouter);
      console.log("[admin] /admin routes enabled (ADMIN_TOKEN set)");
    }
    mountDocs(target, openapiSpec, "IQ Gateway API");
    target.route("/", r.healthRouter);

    target.use("/*", async (c: Context, next: Next) => {
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
      const filePath = (reqPath === "/" || reqPath === "") && recordPath ? `/${recordPath}` : reqPath;
      const response = await serveManifestPath({
        manifestSig: sig, filePath, spaFallback: true,
        ifNoneMatch: c.req.header("If-None-Match") ?? null,
        range: c.req.header("Range") ?? null,
      });
      if (response.status === 304) return c.body(null, 304);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      const body = await response.arrayBuffer();
      return c.body(body, response.status as 200 | 206, headers);
    });

    target.get("/", homeHandler);
    const { startBackfill } = await import("./backfill");
    const { startCatalogBackfillJob } = await import("./cache/catalog-ingest");
    console.log(`IQ Gateway running on port ${port} [${cluster}]`);
    startBackfill();
    startCatalogBackfillJob();
  }
}

export default { port, fetch: app.fetch, idleTimeout: 120 };
