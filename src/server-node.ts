import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { metaRouter, imgRouter, healthRouter, userRouter, tableRouter } from "./routes";
import "dotenv/config";
import { existsSync, mkdirSync } from "node:fs";

// Ensure cache directory exists at startup
const CACHE_DIR = process.env.CACHE_DIR || "./cache";
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

const app = new Hono();

app.use("*", cors());
app.use("*", logger());

app.route("/meta", metaRouter);
app.route("/img", imgRouter);
app.route("/user", userRouter);
app.route("/table", tableRouter);
app.route("/", healthRouter);

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT) || 3000;
console.log(`IQ Gateway running on port ${port} [${process.env.SOLANA_CLUSTER}]`);

serve({
  fetch: app.fetch,
  port
});
