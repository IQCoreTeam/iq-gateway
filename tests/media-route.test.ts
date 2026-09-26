import { test, expect } from "bun:test";
import { Hono } from "hono";
import bs58 from "bs58";
import { mediaRouter } from "../src/routes/media";

let serial = 1;
function fixture(kind: "solana" | "evm", body: unknown, network = kind) {
  const id = kind === "solana" ? bs58.encode(Buffer.alloc(64, serial++)) : "0x" + (serial++).toString(16).padStart(64, "0");
  let reads = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {c.set("chain", {kind, network, readSingleRow: async () => {reads++; return body;}}); await next();});
  app.route("/media", mediaRouter);
  return { app, id, reads: () => reads };
}

for (const kind of ["solana", "evm"] as const) {
  for (const mime of ["image/png", "audio/wav", "video/mp4"]) {
    test(`${kind} serves named ${mime} uploads without reflecting the filename`, async () => {
      const f = fixture(kind, {body: `data:${mime};name=${encodeURIComponent("hello; 世界, #1 (live).wav")};base64,AQIDBA==`});
      const responses = await Promise.all(Array.from({length: 10}, () => f.app.request(`/media/${f.id}`)));
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe(mime);
        expect(response.headers.get("Content-Disposition")).toBeNull();
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
      }
      expect(f.reads()).toBe(1);
      const part = await f.app.request(`/media/${f.id}`, {headers: {Range: "bytes=1-2"}});
      expect(part.status).toBe(206);
      expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 3]);
      expect(f.reads()).toBe(1);
    });
  }
  test(`${kind} reconstructs passive media, caches it and supports byte ranges`, async () => {
    const f = fixture(kind, {body: "data:audio/wav;base64,AQIDBA=="});
    const full = await f.app.request(`/media/${f.id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("audio/wav");
    expect([...new Uint8Array(await full.arrayBuffer())]).toEqual([1,2,3,4]);
    const part = await f.app.request(`/media/${f.id}`, {headers:{Range:"bytes=1-2"}});
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 1-2/4");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2,3]);
    expect(f.reads()).toBe(1);
    expect((await f.app.request(`/media/${f.id}`, {headers:{Range:"bytes=90-"}})).status).toBe(416);
  });
}

test("cache does not cross EVM networks", async () => {
  const one = fixture("evm", {body:"data:image/png;base64,AQ=="}, "robinhood");
  const two = fixture("evm", {body:"data:image/png;base64,Ag=="}, "monad");
  await one.app.request(`/media/${one.id}`);
  const res = await two.app.request(`/media/${one.id}`);
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2]);
  expect(two.reads()).toBe(1);
});

for (const body of ["javascript:alert(1)", "https://private.invalid/file", "data:text/html;base64,AA==", "data:image/svg+xml;base64,AA==", "data:image/png;base64,A===", "data:text/html;name=safe.png;base64,AA==", "data:image/svg+xml;name=safe.png;base64,AA==", "data:image/png;name=a;name=b;base64,AA==", "data:image/png;name=a\r\nb;base64,AA=="]) {
  test(`rejects non-media or malformed input: ${body.slice(0,30)}`, async () => {
    const f = fixture("solana", {body});
    expect((await f.app.request(`/media/${f.id}`)).status).toBe(415);
  });
}
test("invalid IDs never reach chain reads", async () => {
  const f = fixture("solana", null);
  expect((await f.app.request('/media/invalid')).status).toBe(400);
  expect(f.reads()).toBe(0);
});
test("missing and oversized records have explicit statuses", async () => {
  const missing = fixture("solana", null);
  expect((await missing.app.request(`/media/${missing.id}`)).status).toBe(404);
  const large = fixture("solana", {body:'A'.repeat(8*1024*1024+1)});
  expect((await large.app.request(`/media/${large.id}`)).status).toBe(413);
});

for (const body of [
  "data:image/svg+xml;name=image.svg;base64,AA==",
  "data:text/html;name=page.html;base64,AA==",
  "data:audio/wav;name=x;other=y;base64,AA==",
  "data:audio/wav;name=bad%ZZ.wav;base64,AA==",
  "data:audio/wav;name=a,b.wav;base64,AA==",
]) {
  test(`rejects unsupported types and malformed filename parameters: ${body}`, async () => {
    const f = fixture("solana", {body});
    expect((await f.app.request(`/media/${f.id}`)).status).toBe(415);
  });
}
