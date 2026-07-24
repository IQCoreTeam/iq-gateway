// AgentNet skill/workflow NFT data, keyed by BOTH identifiers the mint uri
// carries: /skill/{mint}/{sig} serves standard NFT JSON assembled purely from
// chain. External viewers (marketplaces, explorers, wallets) fetch the mint's
// uri over HTTP expecting JSON with an image field; AgentNet mints inscribe
// their content on-chain instead, so this route presents that content:
//   - name/type      -> the Token-2022 mint account (tokenMetadata + tokenGroupMember)
//   - description/traits/category -> the code-in inscription (sig)
//   - creator/price  -> the gate program's ItemConfig PDA (["item", mint])
// No index or database: any mint resolves the moment it exists on-chain.
//
// Layering: this is the CACHE layer (on-chain data and its assembly). The
// card IMAGE is generated pixels, which is the render layer's job — it lives
// on browser.iqlabs.dev (iq-wide-web), which draws from this one JSON. The
// .png path here only 301s across for anything that cached the old URL.
import { Hono } from "hono";
import { Connection, PublicKey } from "@solana/web3.js";
import { readAsset, generateETag, HELIUS_RPC } from "../chain/solana";
import { metaCache } from "../cache";

export const skillRouter = new Hono();

// AgentNet matched set (env override for devnet runs). Must match seed.ts.
const GATE_PROGRAM = new PublicKey(process.env.AGENTNET_GATE_PROGRAM || "8YmcHuCx323RtqC8mzTJ5CH4oVT8mPKJ7xarcPKbdgof");
const WORKFLOWS_COLLECTION = process.env.AGENTNET_WORKFLOWS_COLLECTION || "6vmWMRWUD34LEjA8eGefegKe5E38WufveMAe2pTm61i8";
const SKILLS_COLLECTION = process.env.AGENTNET_SKILLS_COLLECTION || "BUGHnCh2Pf93tgcxAEfhjd6tUjbY56JrSZdCRXyt7uS5";
// The render layer that draws the card image from this route's JSON.
const BROWSER_URL = (process.env.BROWSER_URL || "https://browser.iqlabs.dev").replace(/\/+$/, "");

const conn = new Connection(HELIUS_RPC || process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com");

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

interface Trait {
  trait_type: string;
  value: string;
}

interface SkillContent {
  name?: string;
  description?: string;
  attributes?: Trait[];
}

interface SkillData {
  name: string;
  type: "skill" | "workflow";
  description: string;
  attributes: Trait[];
  creator: string | null;
  priceLamports: string | null;
}

// ItemConfig (Anchor): disc(8) + bump(1) + item_mint(32) + creator(32) + price(u64 LE)
const OFF_CREATOR = 41;
const OFF_PRICE = 73;

/** Assemble the item data from chain (memory cached as JSON). Price CAN move
 *  on the ItemConfig, so the blob gets a 1h TTL rather than immutable. */
async function loadSkill(mint: string, sig: string): Promise<SkillData | null> {
  const cacheKey = `skillcard:${mint}:${sig}`;
  const cached = metaCache.get(cacheKey);
  if (cached) return JSON.parse(cached) as SkillData;

  const mintPk = new PublicKey(mint);
  const [mintInfo, asset, itemConfig] = await Promise.all([
    conn.getParsedAccountInfo(mintPk),
    readAsset(sig).catch(() => ({ data: null })),
    conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("item"), mintPk.toBuffer()], GATE_PROGRAM)[0]).catch(() => null),
  ]);

  const parsed = mintInfo.value?.data;
  if (!parsed || typeof parsed !== "object" || !("parsed" in parsed)) return null;
  const info = (parsed.parsed as { info?: { extensions?: { extension: string; state?: Record<string, unknown> }[] } }).info;
  const exts = info?.extensions ?? [];
  const tokenMeta = exts.find((e) => e.extension === "tokenMetadata")?.state as { name?: string } | undefined;
  const member = exts.find((e) => e.extension === "tokenGroupMember")?.state as { group?: string } | undefined;
  if (!tokenMeta?.name) return null;

  let content: SkillContent = {};
  if (asset.data) {
    try {
      content = JSON.parse(typeof asset.data === "string" ? asset.data : Buffer.from(asset.data).toString("utf8")) as SkillContent;
    } catch {
      // inscription is not JSON: present the mint fields alone
    }
  }

  const data: SkillData = {
    name: tokenMeta.name,
    type: member?.group === WORKFLOWS_COLLECTION ? "workflow" : "skill",
    description: content.description ?? "",
    attributes: Array.isArray(content.attributes) ? content.attributes : [],
    creator: itemConfig && itemConfig.data.length >= OFF_PRICE + 8 ? new PublicKey(itemConfig.data.subarray(OFF_CREATOR, OFF_CREATOR + 32)).toBase58() : null,
    priceLamports: itemConfig && itemConfig.data.length >= OFF_PRICE + 8 ? itemConfig.data.readBigUInt64LE(OFF_PRICE).toString() : null,
  };
  // A transient RPC failure on the ItemConfig read comes back as null creator/
  // price; caching that for the full hour would pin "price -" on the card, so
  // null-bearing assemblies get a short TTL and heal on the next request.
  metaCache.set(cacheKey, JSON.stringify(data), data.creator ? 60 * 60 * 1000 : 5 * 60 * 1000);
  return data;
}

skillRouter.get("/:mint/:file", async (c) => {
  const mint = c.req.param("mint");
  let sig = c.req.param("file");
  const wantsImage = sig.endsWith(".png");
  if (wantsImage) sig = sig.slice(0, -4);
  if (!PUBKEY_RE.test(mint) || !SIG_RE.test(sig)) return c.json({ error: "expected /skill/{mint}/{inscription-sig}[.png]" }, 400);

  // The image is rendered by the render layer; anything holding the old
  // gateway .png URL follows across.
  if (wantsImage) return c.redirect(`${BROWSER_URL}/skill/${mint}/${sig}.png`, 301);

  const data = await loadSkill(mint, sig);
  if (!data) return c.json({ error: "not found" }, 404);

  const image = `${BROWSER_URL}/skill/${mint}/${sig}.png`;
  const json = {
    name: data.name,
    symbol: data.name.substring(0, 8).toUpperCase(),
    description: data.description,
    image,
    attributes: data.attributes.filter((t) => t.trait_type === "category" || t.trait_type === "skill"),
    inscription: sig, // the on-chain data path (also the last uri segment)
    // Extras beyond the marketplace standard (harmless there), consumed by the
    // render layer so the card route needs no chain code.
    creator: data.creator,
    priceLamports: data.priceLamports,
    itemType: data.type,
    properties: { files: [{ uri: image, type: "image/png" }], category: "image" },
  };
  const jsonStr = JSON.stringify(json);
  const etag = generateETag(jsonStr);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  return c.json(json, 200, { "Cache-Control": "public, max-age=3600", ETag: etag });
});

// ── /collection/{mint} — the umbrella groups' off-chain face ──────────────
// The two collection mints were created WITHOUT a MetadataPointer extension,
// which Token-2022 only accepts at mint creation: they can never carry
// on-chain metadata. This JSON (plus the render layer's /collection PNG) is
// their official face instead — everything here is a constant of the
// collection type, so it caches long.
export const collectionRouter = new Hono();

const COLLECTION_META: Record<string, { name: string; description: string }> = {
  [SKILLS_COLLECTION]: {
    name: "AgentNet Skills",
    description:
      "The AgentNet skills collection. Every member is a soulbound Token-2022 item: a skill an agent can equip, with its full content inscribed on Solana.",
  },
  [WORKFLOWS_COLLECTION]: {
    name: "AgentNet Workflows",
    description:
      "The AgentNet workflows collection. Every member is a soulbound Token-2022 bundle of skills with on-chain gates, inscribed on Solana.",
  },
};

collectionRouter.get("/:mint", (c) => {
  const mint = c.req.param("mint").replace(/\.png$/, "");
  const meta = COLLECTION_META[mint];
  if (!meta) return c.json({ error: "unknown collection" }, 404);
  const image = `${BROWSER_URL}/collection/${mint}.png`;
  const json = {
    name: meta.name,
    symbol: "AGENTNET",
    description: meta.description,
    image,
    properties: { files: [{ uri: image, type: "image/png" }], category: "image" },
  };
  const jsonStr = JSON.stringify(json);
  const etag = generateETag(jsonStr);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  return c.json(json, 200, { "Cache-Control": "public, max-age=86400", ETag: etag });
});
