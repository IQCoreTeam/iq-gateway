import { describe, expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { generateSvg } from "../src/routes/render";
import { renderHtmlPage } from "../src/routes/view";

const sig = "4GA2pXVF79sWUXbygXyWhop5Rs5mBc3cq7S1Vv7VJSHroskpsdCjgcsYENdhRHPNyH3w5AESSow2nDFE5sxRMMD8";

describe("inscription branding", () => {
  test("HTML logos are self-contained and text remains escaped", () => {
    const html = renderHtmlPage("<script>alert(1)</script>", sig, "https://gateway.iqlabs.dev");
    const images = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)];
    expect(images.length).toBe(2);
    for (const [, src] of images) {
      expect(src).toMatch(/^data:image\/(svg\+xml|png);base64,/);
      expect(Buffer.from(src.split(",")[1], "base64").length).toBeGreaterThan(1000);
    }
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
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
  test("keeps ASCII indentation and lines intact while prose can wrap", async () => {
    const { renderHtmlPage: renderEvm } = await import("../src/routes/evm/view");
    for (const render of [renderHtmlPage, renderEvm]) {
      const art = "    .-@@@@-.\n    |  안녕 |\n    '------'";
      const html = render(art, sig, "https://gateway.iqlabs.dev");
      expect(html).toContain(' preformatted" tabindex="0"');
      expect(html).toContain("    .-@@@@-.\n    |  안녕 |");
      const prose = render("Hello friend.\nThis is normal prose.", sig, "https://gateway.iqlabs.dev");
      expect(prose).not.toContain(' preformatted" tabindex="0"');
    }
  });
});
