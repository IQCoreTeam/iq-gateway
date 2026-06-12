// SNS routes.
//
// GET /sns/<domain>            → JSON {domain, owner, record}. The dispatcher
//                                view (iq-wide-web) reads this: `record` is the
//                                SOL-record value the owner pointed the domain
//                                at (a wallet or PDA, raw — the client
//                                classifies it), `owner` is the registry owner
//                                to fall back on. `?fresh=1` skips the cache.
// GET /sns/<domain>/record[/*] → legacy 302 into /site, for sites whose URL/TXT
//                                record holds a /site/<sig> link. Same behavior
//                                .sol.site hosting relies on.

import type { Context } from "hono";
import { Hono } from "hono";
import { resolveDomainToSig, resolveDomainOwner, resolveDomainRecord, resolveDomainUrl } from "../chain/solana/sns";
import { isSafePath } from "../site-hosts";

export const snsRouter = new Hono();

// GET /sns/<domain>/url → JSON {domain, url}. The raw URL record string,
// verbatim (e.g. "browser.iqlabs.dev/<pda>" or "gateway.iqlabs.dev/site/<sig>/
// <file>"). Unlike /record (302 into /site, sig-shaped values only), this hands
// the caller the unparsed value so a client like browser host-routing can
// interpret any URL shape itself. `?fresh=1` skips the cache.
snsRouter.get("/:domain/url", async (c) => {
  const domain = c.req.param("domain").replace(/\.sol(\.site)?$/i, "").toLowerCase();
  if (!domain) return c.text("missing domain", 400);
  const fresh = c.req.query("fresh") === "1";
  try {
    const url = await resolveDomainUrl(domain, fresh);
    return c.json({ domain: `${domain}.sol`, url });
  } catch {
    return c.json({ error: "SNS lookup failed (RPC)" }, 503);
  }
});

snsRouter.get("/:domain", async (c) => {
  const domain = c.req.param("domain").replace(/\.sol(\.site)?$/i, "").toLowerCase();
  if (!domain) return c.text("missing domain", 400);
  const fresh = c.req.query("fresh") === "1";

  // A rejection means RPC failure (a real miss resolves to null). If either
  // lookup failed, report 503 rather than a misleading null for that field —
  // the client can't tell "no record" from "couldn't read" otherwise.
  const [ownerR, recordR] = await Promise.allSettled([
    resolveDomainOwner(domain, fresh),
    resolveDomainRecord(domain, fresh),
  ]);
  if (ownerR.status === "rejected" || recordR.status === "rejected") {
    return c.json({ error: "SNS lookup failed (RPC)" }, 503);
  }

  return c.json({ domain: `${domain}.sol`, owner: ownerR.value, record: recordR.value });
});

snsRouter.get("/:domain/record", (c) => redirectFor(c, c.req.param("domain"), ""));
snsRouter.get("/:domain/record/*", (c) => {
  const domain = c.req.param("domain");
  const prefix = `/sns/${domain}/record/`;
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
  // user-provided path on /sns/<name>/record/<rest> wins over the path baked
  // into the URL record, so people can drill into specific files.
  const target = rest || recordPath;
  return c.redirect(target ? `/site/${sig}/${target}` : `/site/${sig}/`, 302);
}
