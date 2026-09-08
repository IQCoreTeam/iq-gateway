import { describe, test, expect, mock } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), "iq-notify-test-"));
mock.module("../src/chain/evm/log-index", () => ({ scheduleTableBackfill() {} }));
mock.module("../src/cache/catalog-ingest.evm", () => ({ ingestRow: async () => {} }));
const { tableRouter } = await import("../src/routes/evm/table");
const { recordRows } = await import("../src/cache/row-index");
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const chain = { readTableRows: async () => [], readSingleRow: async () => null };
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("chain" as never, chain as never);
  c.set("network" as never, (c.req.query("network") || "robinhood") as never);
  await next();
});
app.route("/table", tableRouter);
async function notify(table: string, row: Record<string, unknown>, n: number) {
  return app.request(`/table/iqchan/${table}/notify`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({txHash:hash(n),row})});
}

describe("EVM notify read-after-write", () => {
  test("a cached thread and ETag see the reply immediately after notify", async () => {
    const thread="qa-thread-a";
    const op={sub:"Topic",threadSeed:thread,threadPda:thread,time:1,__txHash:hash(1)};
    await recordRows([{network:"robinhood",dbroot:"iqchan",tableName:"qa",txHash:hash(1),rowJson:JSON.stringify(op)}]);
    const url=`/table/iqchan/qa/thread/${thread}?replyLimit=500`;
    const first=await app.request(url); const etag=first.headers.get("etag")!;
    expect((await first.json()).replies).toHaveLength(0);
    expect((await notify(thread,{com:"new reply",time:2,threadPda:thread,threadSeed:thread},2)).status).toBe(200);
    const after=await app.request(url,{headers:{"If-None-Match":etag}});
    expect(after.status).toBe(200);
    const body=await after.json();
    expect(body.op.sub).toBe("Topic");
    expect(body.replies.map((r: any)=>r.__txHash)).toEqual([hash(2)]);
    expect(body.totalReplies).toBe(1);
    expect(after.headers.get("etag")).not.toBe(etag);
    await notify(thread,{com:"new reply",time:2,threadPda:thread,threadSeed:thread},2);
    expect((await (await app.request(url)).json()).totalReplies).toBe(1);
  });
  test("new OP is visible in the board feed when notify acknowledges it", async () => {
    const thread="qa-thread-b";
    expect((await (await app.request(`/table/iqchan/new-board/thread/${thread}`)).json()).op).toBeNull();
    await notify("new-board",{sub:"New thread",threadPda:thread,threadSeed:thread,time:3},3);
    expect((await (await app.request(`/table/iqchan/new-board/thread/${thread}`)).json()).op.sub).toBe("New thread");
    const feed=await (await app.request('/table/iqchan/new-board/threads')).json();
    expect(feed.threads.some((t: any)=>t.threadName===thread)).toBe(true);
  });
});

test("notify invalidates every reply limit but preserves other networks", async () => {
  const thread = "qa-thread-limits";
  await notify("limits", { sub: "Limits", threadPda: thread, time: 1 }, 20);
  const url = `/table/iqchan/limits/thread/${thread}`;
  for (const limit of [5, 50, 500]) await app.request(`${url}?replyLimit=${limit}`);
  const other = await app.request(`${url}?network=ethereum`);
  const otherTag = other.headers.get("etag")!;
  await notify(thread, { com: "reply", threadPda: thread, time: 2 }, 21);
  for (const limit of [5, 50, 500]) {
    expect((await (await app.request(`${url}?replyLimit=${limit}`)).json()).replies).toHaveLength(1);
  }
  expect((await app.request(`${url}?network=ethereum`, { headers: { "If-None-Match": otherTag } })).status).toBe(304);
});

test("an older read completing after notify cannot repopulate the stale cache", async () => {
  const thread = "qa-thread-race";
  await notify("race", { sub: "Race", threadPda: thread, time: 1 }, 30);
  let release!: (rows: never[]) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const original = chain.readTableRows;
  chain.readTableRows = async (...args: unknown[]) => {
    if (args[1] === thread) {
      started();
      return new Promise<never[]>((resolve) => { release = resolve; });
    }
    return [];
  };
  try {
    const url = `/table/iqchan/race/thread/${thread}`;
    const old = app.request(url);
    await waiting;
    await notify(thread, { com: "confirmed during old read", time: 2 }, 31);
    expect((await (await app.request(url)).json()).replies).toHaveLength(1);
    release([]);
    await old;
    expect((await (await app.request(url)).json()).replies).toHaveLength(1);
  } finally { chain.readTableRows = original; }
});

test("an invalidated request cannot clear its replacement from the inflight map", async () => {
  const { deduped } = await import("../src/cache/dedup");
  const requests = new Map<string, Promise<unknown>>();
  let resolveOld!: (value: number) => void;
  let resolveNew!: (value: number) => void;
  const old = deduped(requests, "thread", () => new Promise<number>(resolve => { resolveOld = resolve; }));
  requests.delete("thread");
  const current = deduped(requests, "thread", () => new Promise<number>(resolve => { resolveNew = resolve; }));
  resolveOld(1); await old;
  expect(requests.get("thread")).toBe(current);
  resolveNew(2); await current;
  expect(requests.has("thread")).toBe(false);
});
