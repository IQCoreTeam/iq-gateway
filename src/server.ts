import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { metaRouter, imgRouter, healthRouter, userRouter } from "./routes";
import { initRegistry, registerSelf, sendHeartbeat } from "./registry";

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

// Initialize registry if configured
const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
const gatewayUrl = process.env.GATEWAY_URL;
const keypairPath = process.env.KEYPAIR_PATH;

if (rpcUrl && gatewayUrl) {
  initRegistry(rpcUrl, gatewayUrl, keypairPath);

  // Register on startup
  registerSelf().catch((e) => console.error("Registry startup error:", e));

  // Heartbeat every 2 minutes
  setInterval(() => {
    sendHeartbeat().catch((e) => console.error("Heartbeat error:", e));
  }, 120_000);

  console.log(`IQ Gateway running on port ${port} (registry enabled)`);
} else {
  console.log(`IQ Gateway running on port ${port} (registry disabled - set GATEWAY_URL to enable)`);
}

export default { port, fetch: app.fetch, idleTimeout: 120 };
