// /sns/<domain>[/<path>] — resolve a SNS domain to its IQ manifest
// sig and 302 redirect into the existing /site handler so caching, ETags,
// and /site/* routing work the same for both URL shapes.

import type { Context } from "hono";
import { Hono } from "hono";
import { resolveDomainToSig } from "../chain/sns";
import { isSafePath } from "../site-hosts";

export const snsRouter = new Hono();

snsRouter.get("/:domain", (c) => redirectFor(c, c.req.param("domain"), ""));
snsRouter.get("/:domain/*", (c) => {
  const domain = c.req.param("domain");
  const prefix = `/sns/${domain}/`;
  const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
  return redirectFor(c, domain, rest);
});

async function redirectFor(c: Context, rawDomain: string, rest: string): Promise<Response> {
  const domain = rawDomain.replace(/\.sol(\.site)?$/i, "").toLowerCase();
  if (!domain) return c.text("missing domain", 400);
  if (!isSafePath(rest)) return c.text("unsafe path", 400);

  const resolved = await resolveDomainToSig(domain);
  if (!resolved) {
    return c.text(
      `no IQ record found on ${domain}.sol — set the URL record to https://gateway.iqlabs.dev/site/<your-sig>/`,
      404,
    );
  }
  // resolved = "<sig>" or "<sig>/<path>" — split sig from any path the user
  // baked into their URL record.
  const slash = resolved.indexOf("/");
  const sig = slash === -1 ? resolved : resolved.slice(0, slash);
  const recordPath = slash === -1 ? "" : resolved.slice(slash + 1);
  // user-provided path on /sns/<name>/<rest> wins over the path baked into
  // the URL record, so people can drill into specific files.
  const target = rest || recordPath;
  return c.redirect(target ? `/site/${sig}/${target}` : `/site/${sig}/`, 302);
}
