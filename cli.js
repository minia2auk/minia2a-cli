#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Wallet } = require('ethers');

// ── Agent identity ───────────────────────────────────────────────────
// Sent on every request so the gateway can count distinct agents; the server
// keeps only HMAC(secret, id). Identity is per-machine, not per-process — a
// per-process id would count every CLI invocation as a new agent and inflate it.
function agentId() {
  if (process.env.MINIA2A_AGENT_ID) return process.env.MINIA2A_AGENT_ID;
  // Two locations exist across our published clients: this one historically used
  // ~/.minia2a/agent-id, while `minia2a-mcp`, `minia2a-client` and `@minia2a/sdk`
  // read ~/.minia2a-agent-id (the path the gateway's adoption.go names). Reading
  // only one of them mints a second id on a machine that already has one, so that
  // machine is counted as two agents. Read both, in that order.
  const candidates = [
    path.join(os.homedir(), '.minia2a', 'agent-id'),
    path.join(os.homedir(), '.minia2a-agent-id'),
  ];
  for (const file of candidates) {
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing) return existing;
    } catch (e) { /* not created yet — fall through to the next candidate */ }
  }
  const id = 'agent:' + crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(candidates[0]), { recursive: true, mode: 0o700 });
    fs.writeFileSync(candidates[0], id, { mode: 0o600 });
  } catch (e) { /* read-only home — keep the in-memory id */ }
  return id;
}

// The id identifies us to our own gateway. The catalog carries caller-listed
// endpoints on other hosts (the external-api category), and `trial` calls
// whichever one it resolved — so the header is gated on the host. A stable
// per-machine identifier must not travel to a third party.
function isFirstParty(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'minia2a.uk' || h.endsWith('.minia2a.uk');
  } catch (e) {
    return false;
  }
}

function baseHeaders(url) {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'minia2a-cli' };
  if (isFirstParty(url)) headers['X-Agent-ID'] = agentId();
  return headers;
}

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = { ...opts, headers: { ...baseHeaders(url), ...(opts.headers || {}) } };
    https.get(url, options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch(e) { resolve({ status: res.statusCode, data }); } });
    }).on('error', reject);
  });
}

function post(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      method: 'POST',
      headers: {
        ...baseHeaders(url),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      }
    };
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch(e) { resolve({ status: res.statusCode, data }); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Wallet ───────────────────────────────────────────────────────────
// Trials are wallet-based: sign with your own key and you get 5 free calls across
// the catalog, no registration. The key never leaves this process. It persists
// across runs so those 5 trials belong to one wallet, not one invocation.
function loadWallet() {
  const envKey = process.env.MINIA2A_PRIVATE_KEY;
  if (envKey) return new Wallet(envKey.startsWith('0x') ? envKey : '0x' + envKey);

  const dir = path.join(os.homedir(), '.minia2a');
  const file = path.join(dir, 'wallet.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.privateKey) return new Wallet(saved.privateKey);
  } catch (e) { /* no wallet yet */ }

  const w = Wallet.createRandom();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2), { mode: 0o600 });
  } catch (e) { /* read-only home — the wallet just won't persist */ }
  return w;
}

const CYAN = '\x1b[36m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RED = '\x1b[31m', RESET = '\x1b[0m';
const JSON_MODE = process.argv.includes('--json');
const BASE = 'https://minia2a.uk';
const BRAND = DIM + '  ⚡ minia2a.uk — pay-per-call x402 APIs for agents, settled in USDC on Base' + RESET;

async function main() {
  const cmd = process.argv[2] || 'help';

  if (cmd === 'discover') {
    const { data: d } = await fetch(BASE + '/api/services');
    if (JSON_MODE) { console.log(JSON.stringify(d, null, 2)); return; }
    const svcs = d.services || [];
    const top = process.argv.includes('--all') ? svcs : svcs.slice(0, 15);
    console.log(BOLD + '\n  minia2a.uk — Agent API Marketplace' + RESET);
    console.log(DIM + `  ${svcs.length} services. USDC on Base. 5 free trial calls per signed wallet.\n` + RESET);
    for (const s of top) {
      const price = (s.priceCents / 100).toFixed(3);
      const badge = s.trialCount > 0 ? GREEN + ' ⬢' + RESET : '';
      console.log(`  ${CYAN}${s.name}${RESET} | ${YELLOW}$${price}${RESET} | ${DIM}${s.category}${RESET}${badge}`);
    }
    if (!process.argv.includes('--all') && svcs.length > 15) {
      console.log(DIM + `\n  ... and ${svcs.length - 15} more. Use --all to see everything.` + RESET);
    }
    console.log(BRAND);
  } else if (cmd === 'stats') {
    const { data: d } = await fetch(BASE + '/api/stats');
    if (JSON_MODE) { console.log(JSON.stringify(d, null, 2)); return; }
    console.log(BOLD + '\n  minia2a.uk — Platform Stats' + RESET);
    console.log(DIM + '  Live data from ' + BASE + '/api/stats\n' + RESET);
    console.log(`  ${BOLD}Services:${RESET}        ${GREEN}${d.services}${RESET}`);
    console.log(`  ${BOLD}Free Trials:${RESET}     ${CYAN}${d.trials?.totalUsed?.toLocaleString() || 0}${RESET} (${d.trials?.totalUniqueUsers || 0} agents)`);
    console.log(`  ${BOLD}Total Requests:${RESET}  ${d.totalRequests?.toLocaleString()}`);
    console.log(`  ${BOLD}Wallets:${RESET}         ${d.trials?.walletUsers || 0}`);
    console.log(`  ${BOLD}Settled on-chain:${RESET} ${d.realOnChain?.count || 0} payments, $${(d.realOnChain?.usdc || 0).toFixed(2)} USDC`);
    console.log(`  ${BOLD}Uptime:${RESET}         ${Math.floor((d.uptime || 0) / 86400)} days`);
    console.log(BRAND);
  } else if (cmd === 'trial') {
    const svcName = process.argv[3];
    if (!svcName) {
      console.log(BOLD + '\n  Usage:' + RESET + ' minia2a trial <service-name> [--input \'{"key":"val"}\']');
      console.log(DIM + '  Spends one of your 5 free trial calls. The wallet is signed locally —' + RESET);
      console.log(DIM + '  no registration, no payment, and the key never leaves this machine.\n' + RESET);
      console.log('  Example: minia2a trial x402-time');
      console.log('  Example: minia2a trial x402-gas --input \'{"chainId":1}\'');
      process.exit(1);
    }
    const { data: d } = await fetch(BASE + '/api/services');
    const svc = (d.services || []).find(s => s.name === svcName || s.id === svcName);
    if (!svc) {
      console.log(RED + `\n  Service "${svcName}" not found.` + RESET);
      console.log(DIM + '  Try: minia2a discover' + RESET);
      process.exit(1);
    }
    const endpoint = svc.url || svc.endpoint;
    if (!endpoint) {
      console.log(RED + `\n  Service "${svcName}" has no endpoint URL configured.` + RESET);
      process.exit(1);
    }

    let inputBody = {};
    const inputIdx = process.argv.indexOf('--input');
    if (inputIdx !== -1 && process.argv[inputIdx + 1]) {
      try { inputBody = JSON.parse(process.argv[inputIdx + 1]); } catch(e) {
        console.log(RED + '  Invalid JSON for --input' + RESET);
        process.exit(1);
      }
    }

    const wallet = loadWallet();
    // The gateway recovers the signer and compares it to ?wallet=, so the signed
    // message must name the service's catalog id ("x402-time"), not the URL slug.
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = await wallet.signMessage(`minia2a trial:${wallet.address}:${svc.id}:${ts}`);

    const url = endpoint + (endpoint.includes('?') ? '&' : '?') + 'wallet=' + wallet.address;
    console.log(BOLD + `\n  🔬 Trial: ${svc.name}` + RESET + DIM + ` — ${svc.category}` + RESET);
    console.log(DIM + `  Wallet: ${wallet.address}` + RESET);
    console.log(DIM + `  Calling: ${url}` + RESET);

    const { status, data: result } = await post(url, inputBody, {
      'X-Wallet-Signature': signature,
      'X-Trial-Timestamp': ts,
    });

    // Exit code contract (1.1.3): the trial succeeded iff the gateway answered
    // 200. Before this, the 402 path printed the refusal and returned without
    // setting an exit code, so `minia2a trial` exited 0 on a call it had just
    // reported as refused -- and every caller that gated on the exit code, e.g.
    // `if npx minia2a-cli trial X; then echo ok; fi`, reported a spent wallet as
    // a successful call. Every other failure path here already exits 1; this one
    // was the outlier. process.exitCode (not process.exit) so stdout still flushes.
    if (JSON_MODE) {
      console.log(JSON.stringify(result, null, 2));
      if (status !== 200) process.exitCode = 1;
      return;
    }

    console.log(`  ${BOLD}Status:${RESET}  ${status === 200 ? GREEN + '200 OK' + RESET : YELLOW + status + RESET}`);

    if (status === 402) {
      // A 402 here has more than one cause, and only the gateway knows which: this
      // wallet used its 5 calls, or the service is payment-only by design and grants
      // no trial to anyone. This branch used to assert exhaustion unconditionally,
      // so a brand-new wallet with all 5 calls intact was told it had none left --
      // the gateway's own message, one line below, said the opposite. Claim
      // exhaustion only on the gateway's word, never on our own.
      const msg = String(result.message || '');
      const exhausted = /exhausted/i.test(msg);
      if (exhausted) {
        console.log(RED + '  This wallet has no trial calls left for this endpoint.' + RESET);
      }
      console.log(DIM + `  ${msg || 'Payment required.'}` + RESET);
      const opt = Array.isArray(result.accepts) ? result.accepts[0] : null;
      if (opt) {
        console.log(`  ${BOLD}To pay per call:${RESET} ${YELLOW}$${(Number(opt.amount) / 1e6).toFixed(4)} USDC${RESET} ${DIM}on ${opt.network}${RESET}`);
      }
      // Same reason: a fresh wallet only helps where trials exist at all.
      if (exhausted) {
        console.log(DIM + `  Any other wallet gets its own 5 free calls: MINIA2A_PRIVATE_KEY=0x... minia2a trial ${svcName}` + RESET);
      }
      console.log(BRAND);
      process.exitCode = 1;
      return;
    }

    if (result && typeof result === 'object') {
      const keys = Object.keys(result);
      for (const k of keys.slice(0, 8)) {
        const val = typeof result[k] === 'object' ? JSON.stringify(result[k]).slice(0, 80) : String(result[k]).slice(0, 120);
        console.log(`  ${CYAN}${k}:${RESET} ${val}`);
      }
      if (keys.length > 8) console.log(DIM + `  ... and ${keys.length - 8} more fields` + RESET);
    }
    console.log(DIM + `\n  💡 ${svc.trialCount || 0} trials used on this endpoint. 5 free per wallet across the catalog.` + RESET);
    console.log(BRAND);
    // Anything that is not a 200 is not a completed trial, whatever it printed.
    // Covers the 400/5xx paths the early sniff above does not special-case.
    if (status !== 200) process.exitCode = 1;
  } else if (cmd === 'wallet') {
    const wallet = loadWallet();
    console.log(BOLD + '\n  💳 Your wallet' + RESET);
    console.log(DIM + '  Self-custody, generated locally. minia2a never holds the key.\n' + RESET);
    console.log(`  ${BOLD}Address:${RESET}  ${CYAN}${wallet.address}${RESET}`);
    console.log(`  ${BOLD}Key file:${RESET} ${DIM}~/.minia2a/wallet.json (chmod 600), or set MINIA2A_PRIVATE_KEY${RESET}\n`);
    console.log(`  ${BOLD}1. Spend a free trial${RESET} — one of 5 per wallet, no registration:`);
    console.log(`     ${CYAN}minia2a trial x402-time${RESET}`);
    console.log(`\n  ${BOLD}2. Pay per call after the trials run out${RESET} — the endpoint answers 402`);
    console.log(`     with an accepts[] array; sign an x402 payment and retry with a`);
    console.log(`     PAYMENT-SIGNATURE header. There is no credit balance to top up:`);
    console.log(`     every paid call settles ${YELLOW}USDC on Base${RESET} on the spot.`);
    console.log(`\n  ${BOLD}3. Let the client do the paying${RESET} — it wraps fetch and retries 402s:`);
    console.log(`     ${CYAN}npm install minia2a-client${RESET}`);
    console.log(DIM + `\n  → Docs: ${BASE}/docs` + RESET);
    console.log(BRAND);
  } else if (cmd === 'register') {
    console.log(BOLD + '\n  🚀 List Your Endpoint on minia2a.uk' + RESET);
    console.log(DIM + '  Publish an API other agents can call and pay for.\n' + RESET);
    console.log(`  1. Make sure your endpoint accepts POST and returns JSON`);
    console.log(`  2. Sign  minia2a register: <your-wallet>  with EIP-191, then register that wallet:`);
    console.log(`     ${CYAN}curl -X POST ${BASE}/api/v1/register-simple \\${RESET}`);
    console.log(`       ${CYAN}-H "content-type: application/json" \\${RESET}`);
    console.log(`       ${CYAN}-d '{"name":"my-api","wallet":"0x...","signature":"0x..."}'${RESET}`);
    console.log(`  3. List the endpoint (same wallet, same signature):`);
    console.log(`     ${CYAN}curl -X POST ${BASE}/api/v1/publish-service \\${RESET}`);
    console.log(`       ${CYAN}-H "content-type: application/json" \\${RESET}`);
    console.log(`       ${CYAN}-d '{"name":"my-api","endpoint":"https://my-api.com/agent","price_cents":5,"wallet":"0x...","signature":"0x..."}'${RESET}`);
    console.log(`  4. Callers get 5 free trial calls per signed wallet, then pay per call`);
    console.log(`  5. Listed on ${BASE}/catalog — agents can find and call you`);
    console.log(`  6. 5% platform fee — 0% through 2026. Settled in USDC on Base.`);
    console.log(DIM + `\n  → Full docs: ${BASE}/register.html` + RESET);
    console.log(BRAND);
  } else if (cmd === 'call') {
    const svcName = process.argv[3];
    if (!svcName) {
      console.log('Usage: minia2a call <service-name> [--json]');
      console.log('Example: minia2a call x402-time');
      process.exit(1);
    }
    const { data: d } = await fetch(BASE + '/api/services');
    const svc = (d.services || []).find(s => s.name === svcName || s.id === svcName);
    if (!svc) {
      console.log(`Service "${svcName}" not found. Try: minia2a discover`);
      process.exit(1);
    }
    if (JSON_MODE) {
      console.log(JSON.stringify(svc, null, 2));
    } else {
      console.log(BOLD + `\n  ${svc.name}` + RESET + DIM + ` — ${svc.category}` + RESET);
      console.log(`  ${BOLD}Description:${RESET} ${svc.description || '(none)'}`);
      console.log(`  ${BOLD}Price:${RESET}       ${YELLOW}$${(svc.priceCents/100).toFixed(4)} USDC${RESET}`);
      console.log(`  ${BOLD}Endpoint:${RESET}     ${DIM}${svc.url || svc.endpoint || '(see docs)'}${RESET}`);
      // trialCount is the gateway's cumulative count of trial calls this service has
      // served, not a number still available to you -- an unlabelled "Trials: 9836"
      // sat directly under a description reading "No free trial", which is a
      // contradiction the reader has to resolve themselves.
      console.log(`  ${BOLD}Trials used:${RESET} ${svc.trialCount || 0}`);
      if (svc.apiDocs) console.log(`  ${BOLD}Docs:${RESET}        ${DIM}${svc.apiDocs}${RESET}`);
      // Not every service runs trials — a payment-only one answers this suggestion
      // with the 402 above it. The catalog carries no eligibility flag, so the line
      // states the condition instead of promising the outcome.
      console.log(DIM + `\n  → Free trial where offered: minia2a trial ${svcName}` + RESET);
      console.log(DIM + `  → Wallet + payment: minia2a wallet` + RESET);
      console.log(BRAND);
    }
  } else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(BOLD + '\n  ⚡ minia2a' + RESET + DIM + ' — CLI for the agent-to-agent API marketplace\n' + RESET);
    console.log(`  ${BOLD}minia2a discover${RESET}       Browse the catalog [--all, --json]`);
    console.log(`  ${BOLD}minia2a trial <name>${RESET}    Spend a free trial call (signed wallet, 5 max)`);
    console.log(`  ${BOLD}minia2a call <name>${RESET}     Show service details [--json]`);
    console.log(`  ${BOLD}minia2a stats${RESET}          Live platform stats [--json]`);
    console.log(`  ${BOLD}minia2a wallet${RESET}         Your local wallet + how payment works`);
    console.log(`  ${BOLD}minia2a register${RESET}       List your own endpoint and earn USDC`);
    console.log(DIM + `\n  Add --json to any command for machine-readable output.` + RESET);
    console.log(DIM + `  ${BASE} — pay-per-call x402 APIs, USDC on Base, 5 free trials per wallet` + RESET);
  } else {
    console.log(RED + `\n  Unknown command: ${cmd}` + RESET);
    console.log(DIM + '  Try: minia2a help' + RESET);
    console.log(DIM + '  Quick start: minia2a discover' + RESET);
  }
}

main().catch(e => { console.error(RED + 'Error:' + RESET, e.message); process.exit(1); });
