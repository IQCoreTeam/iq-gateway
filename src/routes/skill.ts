// AgentNet skill/workflow NFT presentation, keyed by BOTH identifiers the mint
// uri carries: /skill/{mint}/{sig} serves standard NFT JSON, /skill/{mint}/{sig}.png
// the terminal card image. External viewers (marketplaces, explorers, wallets)
// fetch the mint's uri over HTTP expecting JSON with an image field; AgentNet
// mints inscribe their content on-chain instead, so this route presents that
// content. Everything is assembled from chain only:
//   - name/type      -> the Token-2022 mint account (tokenMetadata + tokenGroupMember)
//   - description/traits/category -> the code-in inscription (sig)
//   - creator/price  -> the gate program's ItemConfig PDA (["item", mint])
// No index or database: any mint resolves the moment it exists on-chain.
import { Hono } from "hono";
import { Connection, PublicKey } from "@solana/web3.js";
import { readAsset, generateETag, HELIUS_RPC } from "../chain/solana";
import { metaCache, imageCache, TTL, getDiskCache, setDiskCache } from "../cache";
import { renderCard, type CardData } from "../skill-card/card";

export const skillRouter = new Hono();

// AgentNet matched set (env override for devnet runs). Must match seed.ts.
const GATE_PROGRAM = new PublicKey(process.env.AGENTNET_GATE_PROGRAM || "8YmcHuCx323RtqC8mzTJ5CH4oVT8mPKJ7xarcPKbdgof");
const WORKFLOWS_COLLECTION = process.env.AGENTNET_WORKFLOWS_COLLECTION || "6vmWMRWUD34LEjA8eGefegKe5E38WufveMAe2pTm61i8";

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

// ItemConfig (Anchor): disc(8) + bump(1) + item_mint(32) + creator(32) + price(u64 LE)
const OFF_CREATOR = 41;
const OFF_PRICE = 73;

/** Assemble the card data from chain (memory+disk cached as JSON). The card
 *  excludes mutable market fields, but price CAN move on the ItemConfig, so
 *  the assembled blob gets a 1h memory TTL rather than immutable. */
async function loadCard(mint: string, sig: string): Promise<CardData | null> {
  const cacheKey = `skillcard:${mint}:${sig}`;
  const cached = metaCache.get(cacheKey);
  if (cached) return JSON.parse(cached) as CardData;

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
      // inscription is not JSON: render from mint fields alone
    }
  }
  const attrs = Array.isArray(content.attributes) ? content.attributes : [];

  const data: CardData = {
    name: tokenMeta.name,
    type: member?.group === WORKFLOWS_COLLECTION ? "workflow" : "skill",
    category: attrs.find((t) => t.trait_type === "category")?.value,
    hashtags: attrs.filter((t) => t.trait_type === "skill").map((t) => t.value),
    description: content.description ?? "",
    creator: itemConfig && itemConfig.data.length >= OFF_PRICE + 8 ? new PublicKey(itemConfig.data.subarray(OFF_CREATOR, OFF_CREATOR + 32)).toBase58() : null,
    priceLamports: itemConfig && itemConfig.data.length >= OFF_PRICE + 8 ? itemConfig.data.readBigUInt64LE(OFF_PRICE).toString() : null,
  };
  metaCache.set(cacheKey, JSON.stringify(data), 60 * 60 * 1000);
  return data;
}

skillRouter.get("/:mint/:file", async (c) => {
  const mint = c.req.param("mint");
  let sig = c.req.param("file");
  const wantsImage = sig.endsWith(".png");
  if (wantsImage) sig = sig.slice(0, -4);
  if (!PUBKEY_RE.test(mint) || !SIG_RE.test(sig)) return c.json({ error: "expected /skill/{mint}/{inscription-sig}[.png]" }, 400);

  if (wantsImage) {
    const cacheKey = `skillimg:${mint}:${sig}`;
    let buf = imageCache.get(cacheKey);
    if (!buf) {
      const disk = await getDiskCache("skillimg", `${mint}-${sig}`);
      if (disk) {
        buf = disk;
        imageCache.set(cacheKey, buf, TTL.IMAGE);
      }
    }
    if (!buf) {
      const data = await loadCard(mint, sig);
      if (!data) return c.text("not found", 404);
      buf = renderCard(data);
      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("skillimg", `${mint}-${sig}`, buf);
    }
    return c.body(new Uint8Array(buf) as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    });
  }

  const data = await loadCard(mint, sig);
  if (!data) return c.json({ error: "not found" }, 404);

  const proto = c.req.header("X-Forwarded-Proto") || "http";
  const host = c.req.header("Host") || "localhost:3000";
  const image = `${proto}://${host}${process.env.BASE_PATH || ""}/skill/${mint}/${sig}.png`;

  const json = {
    name: data.name,
    symbol: data.name.substring(0, 8).toUpperCase(),
    description: data.description,
    image,
    attributes: [
      ...(data.category ? [{ trait_type: "category", value: data.category }] : []),
      ...data.hashtags.map((value) => ({ trait_type: "skill", value })),
    ],
    inscription: sig, // the on-chain data path (also the last uri segment)
    properties: { files: [{ uri: image, type: "image/png" }], category: "image" },
  };
  const jsonStr = JSON.stringify(json);
  const etag = generateETag(jsonStr);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  return c.json(json, 200, { "Cache-Control": "public, max-age=3600", ETag: etag });
});
