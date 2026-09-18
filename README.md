# minia2a CLI

Command-line interface for [minia2a.uk](https://minia2a.uk) — a pay-per-call marketplace where AI agents discover and call x402 APIs, settling each call in USDC on Base.

## Install

```bash
npm install -g minia2a-cli
```

Requires Node.js 18+. One dependency (`ethers`, for local wallet signing).

## Quick start

```bash
# Browse the catalog
minia2a discover

# Spend one of your 5 free trial calls
minia2a trial x402-time

# Look at a single service
minia2a call x402-gas

# Live platform stats
minia2a stats
```

## Commands

| Command | Description |
|---------|-------------|
| `discover [--all] [--json]` | Browse the service catalog |
| `trial <service> [--input '{...}']` | Call a service with one of your 5 free trial calls |
| `call <service> [--json]` | Show price, endpoint and trial count for a service |
| `stats [--json]` | Live platform statistics |
| `wallet` | Show your local wallet and how payment works |
| `register` | List your own endpoint on the marketplace |
| `help` | Show usage |

## How trials work

There is no account and no credit balance. Trials are **wallet-based**:

1. The CLI generates a self-custody wallet on first use and stores the key at
   `~/.minia2a/wallet.json` (mode 600). Set `MINIA2A_PRIVATE_KEY` to use your own.
2. `minia2a trial <service>` signs `minia2a trial:<wallet>:<serviceId>:<unixSeconds>`
   locally and sends the signature — the private key never leaves your machine.
3. Each wallet gets **5 free trial calls** across the whole catalog, not per service.

Once a wallet's trials are used up the endpoint answers `402 Payment Required`
with an `accepts[]` array describing the price (fractional USDC on Base). There is
nothing to top up: you sign an x402 payment for that one call and retry with a
`PAYMENT-SIGNATURE` header. The [minia2a-client](https://www.npmjs.com/package/minia2a-client)
package wraps `fetch` and does that automatically.

## Registering an endpoint

`minia2a register` prints the request to list a POST + JSON endpoint. Callers pay
per call; the platform fee is 5% (0% through 2026), settled in USDC on Base.

## The x402 protocol

x402 extends HTTP `402 Payment Required` into a machine-readable payment request:

- client requests an endpoint
- server replies `402` with price, asset and recipient
- client pays in USDC on Base and retries with proof of payment
- server returns the result

No API keys, no subscriptions, no accounts.

## Links

- [minia2a.uk](https://minia2a.uk) — marketplace
- [minia2a-client](https://www.npmjs.com/package/minia2a-client) — auto-paying client
- [minia2a-mcp](https://www.npmjs.com/package/minia2a-mcp) — MCP server
- [x402.org](https://x402.org) — protocol

## License

MIT
