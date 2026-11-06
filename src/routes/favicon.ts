import { Hono } from "hono";

export const faviconRouter = new Hono();
const icons = {
  "/favicon.ico": { file: new URL("../../public/favicon.ico", import.meta.url), type: "image/x-icon" },
  "/favicon.png": { file: new URL("../../public/favicon.png", import.meta.url), type: "image/png" },
};

// Explicit paths also work when the process starts outside the repository root.
faviconRouter.on("GET", Object.keys(icons), (c) => {
  const icon = icons[c.req.path as keyof typeof icons];
  return new Response(Bun.file(icon.file), {
    headers: { "Content-Type": icon.type, "Cache-Control": "public, max-age=86400" },
  });
});
