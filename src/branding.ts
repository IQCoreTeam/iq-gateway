import { readFileSync } from "node:fs";

// Original artwork from IQCoreTeam/iq-wide-web public assets. Bundle it with
// the gateway so HTML and server-rendered previews do not depend on a host
// outside this deployment or on resvg resolving relative image filenames.
export const IQ_LOGO = `data:image/svg+xml;base64,${readFileSync(new URL("../public/iq_logo.svg", import.meta.url)).toString("base64")}`;
export const SOLANA_INTERNET_LOGO = `data:image/png;base64,${readFileSync(new URL("../public/solana-internet.png", import.meta.url)).toString("base64")}`;

// Rendered previews depend on our template, unlike immutable on-chain bytes.
export const RENDER_REVISION = "branding-1";
