import { describe, expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { generateSvg } from "../src/routes/render";
import { textScreen, renderPage } from "../src/routes/view";

const sig = "4GA2pXVF79sWUXbygXyWhop5Rs5mBc3cq7S1Vv7VJSHroskpsdCjgcsYENdhRHPNyH3w5AESSow2nDFE5sxRMMD8";
const BASE = "https://gateway.iqlabs.dev";

describe("inscription console", () => {
  test("page escapes inscription content and readout, never injects markup", () => {
    const screen = { kind: "TEXT", size: "25 B", who: "<b>x</b>", top: true, html: textScreen("<script>alert(1)</script>") };
    const html = renderPage(sig, BASE, screen, "og");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;"); // body escaped
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;"); // readout value escaped
  });

  test("resvg paints both bundled logos into the actual PNG", () => {
    const svg = generateSvg("  안녕 친구\n  frog", sig);
    const withLogos = new Resvg(svg).render();
    const withoutLogos = new Resvg(svg.replace(/<image\b[^>]*\/>/g, "")).render();
    const a = withLogos.pixels;
    const b = withoutLogos.pixels;
    let titleChanges = 0;
    let footerChanges = 0;
    for (let y = 0; y < withLogos.height; y++) {
      for (let x = 0; x < withLogos.width; x++) {
        const offset = (y * withLogos.width + x) * 4;
        if (a.subarray(offset, offset + 4).equals(b.subarray(offset, offset + 4))) continue;
        if (x < 40 && y < 40) titleChanges++;
        if (x > 650 && y > withLogos.height - 90) footerChanges++;
      }
    }
    expect(titleChanges).toBeGreaterThan(50);
    expect(footerChanges).toBeGreaterThan(100);
    expect(withLogos.asPng().subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("inscription layout", () => {
  const art = "    .-@@@@-.\n    |  안녕 |\n    '------'";

  test("solana console: ascii keeps indentation in a <pre>, prose wraps", () => {
    const ascii = textScreen(art);
    expect(ascii).toContain("<pre>");
    expect(ascii).toContain("    .-@@@@-.\n    |  안녕 |");
    const prose = textScreen("Hello friend.\nThis is normal prose.");
    expect(prose).toContain('class="v-text"');
    expect(prose).not.toContain("<pre>");
  });

  test("evm viewer: ascii stays preformatted while prose can wrap", async () => {
    const { renderHtmlPage: renderEvm } = await import("../src/routes/evm/view");
    const html = renderEvm(art, sig, BASE, `https://solscan.io/tx/${sig}`);
    expect(html).toContain(' preformatted" tabindex="0"');
    expect(html).toContain("    .-@@@@-.\n    |  안녕 |");
    const prose = renderEvm("Hello friend.\nThis is normal prose.", sig, BASE, `https://solscan.io/tx/${sig}`);
    expect(prose).not.toContain(' preformatted" tabindex="0"');
  });
});
