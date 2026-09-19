# Run the IQ gateway with Akash Console Air

We restored https://gateway.solanainternet.com by running Akash Console Air locally, connecting our existing Keplr wallet, and deploying the SDL linked below. This guide explains the same workflow for Zo.

We can keep the frontend wherever and however Zo hosts it now. We also have recovered Arweave frontend work and optional Solana hosting research; would you like those details separately? Neither is needed to operate this gateway.

## What is live

Production is **Solana-only**, using one free Helius RPC key through `SOLANA_RPC_ENDPOINT`, as confirmed by the owner. Zo also has a free key and can use hers or whichever RPC setup she prefers. There is no RPC-key rotation, and the optional Helius batch API is disabled. No key is included in this repository.

If Zo needs funds, I can send her SOL; she can let me know what she needs. This is an offer, not a completed transfer. Akash hosting itself is funded with ACT, with AKT kept for network fees.

| Item | Value |
|---|---|
| Gateway | https://gateway.solanainternet.com |
| Deployment DSEQ | `28688125` |
| Owner wallet | `akash1yz0080hzn89vny5qwx845ttanvqfeefhv6wv80` |
| Provider | `akash1hgulk6aekakqzc0v6wukrd3dy9n90f5gkl4ezk` |
| Source commit | `25427b3f50a4d0f8db365b6be0eb029358d1cda2` |
| Container image | `ghcr.io/iqcoreteam/iq-gateway@sha256:7fce271cf560ebfd3760e966c174674816cbe47deca2f63ec5b44f0a121e1a5b` |
| Resources | 4 CPU, 4 GiB RAM, 1 GiB ephemeral disk, 10 GiB persistent cache |
| Accepted lease price | 18 uACT/block; approximately 7.776 ACT per 30 days at 6-second blocks |

Last operational check: September 19, 2026, 04:34 UTC (September 18 Pacific). Deployment and lease were active; `/health` returned `ok`; a real table read returned HTTP 200. Previous gateway local tests passed 114 tests.

Funding snapshot: initial 10 ACT plus a confirmed 23.328 ACT top-up. After estimated accrued rent through block 28689859, about 33.297112 ACT remained, approximately 128.5 days at 6-second blocks. Wallet balance was 53.791103 AKT plus 0.169236 ACT. These are dated snapshots, not a guaranteed expiry date or live balance.

Top-up transaction: `0E0BBD54E841CE34E85DC28C25C048EC846D901A78979B66CF9A2E69C40BC9D6`.

## 1. Start Console Air locally

Use [Akash Console Air](https://github.com/akash-network/console-air), the wallet-based self-hosted console. We used version 1.1.1 at commit `f072b11ae8fb60249b6968826ad75e5f130c8c74`, running in Ubuntu/WSL and opened in a Windows browser with Keplr.

Install a current Node.js 22 LTS release and npm 11, then:

```bash
git clone https://github.com/akash-network/console-air.git
cd console-air
git checkout f072b11ae8fb60249b6968826ad75e5f130c8c74
npm install
npm --workspace apps/deploy-web run dev -- --hostname 127.0.0.1 --port 3188
```

Open http://localhost:3188 in the browser that has Keplr installed. Console Air ships with hosted API/RPC defaults, so a separate local backend is not required. The local install may refresh its package lock; it is separate from the gateway repository.

## 2. Connect the wallet

Choose **Connect Wallet → Keplr**, approve the connection, and use Akash mainnet.

To manage our existing deployment, the connected wallet address must match the owner above. In our recovery browser this wallet was named `dddd`. Connecting another wallet does not give it control of this deployment.

Zo can follow the same instructions using her own wallet to deploy her own copy. Access to the current owner wallet and Cloudflare account can be arranged privately if we decide she should operate this existing instance. This guide does not transfer ownership or share keys.

Keep some native AKT for network fees. Hosting escrow uses ACT; obtain ACT through the console's available conversion flow, check the quote, and fund the deployment. Sending AKT to a wallet alone does not add hosting time.

## 3. Use the SDL

Open [akash-recovery.template.yaml](./akash-recovery.template.yaml). It matches the recovery SDL's configuration with the RPC URL replaced by a placeholder. The image is pinned to the deployed digest.

In a private local copy, replace `REPLACE_WITH_WORKING_RPC_ENDPOINT` with the working mainnet Helius RPC URL. Do not commit the filled-in copy. Keep `IQ_CHAIN=solana` to reproduce the current production service.

**Existing deployment:** open DSEQ `28688125`, inspect its current manifest and status, then use its update workflow if an actual change is needed. Keep the persistent cache volume. There is no need to create a duplicate deployment just to manage the working one.

**New deployment:** create a deployment from the SDL, review its deposit and provider bids, choose a provider, create the lease, and send the manifest. Approve the requested transactions in the connected wallet. The SDL price is a bid ceiling of about 18.324451 uACT/block; our accepted bid was 18 uACT/block. A new deployment's available bids and price may differ.

If using another hostname, change the SDL's `accept` hostname before deployment. After the provider starts the service, copy the assigned ingress hostname and check its status/logs. Do not assume a new deployment will get our current hostname.

If Console Air asks for a deployment certificate, create/select one for the connected wallet. Certificates are stored in the browser. Use **App Settings → General → Export Local Data** to back them up privately; never add that export to Git. Moving browsers may require importing that backup or issuing a new certificate. See the [Console Air self-custody guide](https://github.com/akash-network/console-air/blob/f072b11ae8fb60249b6968826ad75e5f130c8c74/docs/self-custody.md).

## 4. Point Cloudflare at the provider

Our current settings in the `solanainternet.com` zone are:

| Setting | Value |
|---|---|
| Record | CNAME `gateway` |
| Target | `mv0rj8i5bl81h97nevfvj5i2f8.ingress.h4i-dedicated.eu-sw-2.digitalfrontier.so` |
| Proxy | Proxied |
| TTL | Auto |
| SSL/TLS mode | Full |

Keep this target for the existing deployment. For a replacement deployment, verify its ingress first and then change the CNAME to the new provider hostname. Save the previous value for rollback. Preserve the zone's MX, SPF, and DKIM records. Apex/www frontend routing is outside this guide.

## 5. Verify and keep it funded

Check https://gateway.solanainternet.com/health for `status: ok`, then a real read:

https://gateway.solanainternet.com/table/FBwdrXug9cxuihupVzeN9B3Ajdx19WvxQgTDoRddpyGZ/rows?limit=10

Check provider logs and remaining escrow in Console Air. Add ACT to the existing deployment when needed; confirm the owner address and DSEQ before depositing. At the current lease price, 23.328 ACT buys approximately 90 days at 6-second blocks, excluding changes in block timing.

For a failed update, restore the known image/configuration through the existing deployment. If DNS was changed, restore the previous working target. Do not close a working deployment while diagnosing an update.

## EVM status

EVM was tested locally, not enabled in production. The same image can serve Solana plus EVM when `IQ_CHAIN` is **unset**. In this revision, explicitly setting `IQ_CHAIN=multi` incorrectly produces an empty chain map. Keep the production SDL Solana-only until a separate EVM rollout is agreed. No frontend hosting changes are needed.