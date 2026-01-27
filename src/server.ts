import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { metaRouter, imgRouter, healthRouter, userRouter } from "./routes";

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
console.log(`IQ Gateway running on port ${port}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
