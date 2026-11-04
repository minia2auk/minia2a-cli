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
  // ~/.minia2a/agent-id, while `minia2a-mcp`, `minia2a-client`, `@minia2a/sdk`
  // and the skill use ~/.minia2a-agent-id (the path the gateway's adoption.go
  // names). Reading only one of them mints a second id on a machine that already
  // has one, so that machine is counted as two agents. Read both.
  //
  // The ORDER is not cosmetic. A machine that holds both files is exactly the
  // machine this was written for — an older CLI wrote ~/.minia2a/agent-id, then
  // an older client failed to see it and minted ~/.minia2a-agent-id. Reading
  // both only converges if every client prefers the same one; 1.1.8 preferred
  // the CLI-era path while the other four preferred the canonical path, so the
  // CLI still reported a different identity than the packages installed next to
  // it. Prefer the gateway-documented path, here and everywhere.
  const candidates = [
    path.join(os.homedir(), '.minia2a-agent-id'),
    path.join(os.homedir(), '.minia2a', 'agent-id'),
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

// The gateway answers a served trial with its own quota headers:
// x-trial-mode=wallet, x-trial-max=5, x-trial-remaining=N. The CLI used to drop
// them and print the catalog's lifetime trialCount instead -- "2 trials used on
// this endpoint" on a wallet that had spent nothing reads as the caller's usage.
function trialQuota(headers) {
  if (!headers) return null;
  const remaining = headers['x-trial-remaining'];
  const max = headers['x-trial-max'];
  const mode = headers['x-trial-mode'];
  if (remaining === undefined && max === undefined && mode === undefined) return null;
  const num = v => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? null : Number(v);
  return { mode: mode || null, remaining: num(remaining), max: num(max) };
}

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = { ...opts, headers: { ...baseHeaders(url), ...(opts.headers || {}) } };
    https.get(url, options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); } catch(e) { resolve({ status: res.statusCode, data, headers: res.headers }); } });
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
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); } catch(e) { resolve({ status: res.statusCode, data, headers: res.headers }); } });
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

  const dir = WALLET_DIR;
  const file = WALLET_FILE;
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

// Same paths loadWallet writes, named once so `wallet` can print the file it
// actually used instead of the literal string "~/.minia2a/wallet.json".
const WALLET_DIR = path.join(os.homedir(), '.minia2a');
const WALLET_FILE = path.join(WALLET_DIR, 'wallet.json');

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
  } else if (cmd === 'search') {
    // The catalog's `q` is token-AND: every word must appear in id+name+description,
    // so a phrasing the description does not use returns 0 and a caller reads that
    // as "this marketplace has no such capability". Measured 2026-10-24 over 40
    // natural phrasings: 10 did not surface the endpoint that existed, and 7 of
    // those returned nothing at all ("uuid generator", "url shortener", "email
    // validation"). The server-side fix is a stem/prefix match; until then this
    // command relaxes *client-side* and says so, rather than printing an empty
    // list as an answer.
    const argv = process.argv.slice(3);
    const li = argv.indexOf('--limit');
    let limit = 10;
    if (li !== -1) { limit = Math.max(1, parseInt(argv[li + 1], 10) || 10); argv.splice(li, 2); }
    const words = argv.filter(a => !a.startsWith('--'));
    if (!words.length) {
      console.log(BOLD + '\n  Usage:' + RESET + ' minia2a search <words> [--limit N]');
      console.log(DIM + '  Finds endpoints by what you want to do, in plain words.\n' + RESET);
      console.log('  Example: minia2a search uuid generator');
      console.log('  Example: minia2a search "url shortener" --limit 5');
      process.exit(1);
    }

    const get = async (q) => {
      const { data } = await fetch(BASE + '/api/services?limit=50&q=' + encodeURIComponent(q));
      return (data && data.services) || [];
    };
    const attempts = [];
    const seen = new Map();
    const take = (q, rows) => {
      if (attempts.some(a => a.q === q)) return;
      attempts.push({ q, n: rows.length });
      for (const s of rows) if (!seen.has(s.id)) seen.set(s.id, s);
    };

    take(words.join(' '), await get(words.join(' ')));
    if (!seen.size && words.length > 1) {
      // Drop one word at a time before falling back to single words: "uuid
      // generator" -> "uuid" is the useful retry, and it keeps the ranking of
      // the longest query that still matched.
      for (let i = 0; i < words.length; i++) {
        const q = words.slice(0, i).concat(words.slice(i + 1)).join(' ');
        take(q, await get(q));
      }
    }
    if (!seen.size) for (const w of words) take(w, await get(w));

    const results = [...seen.values()].slice(0, limit);
    if (JSON_MODE) {
      console.log(JSON.stringify({ query: words.join(' '), attempts, results }, null, 2));
      if (!results.length) process.exit(1);
      return;
    }

    console.log(BOLD + `\n  🔎 ${words.join(' ')}` + RESET + DIM + ` — ${results.length} match(es)` + RESET);
    if (attempts.length > 1) {
      const used = attempts.filter(a => a.n > 0).map(a => `"${a.q}"=${a.n}`).join(', ');
      console.log(DIM + `  All words together matched nothing; relaxed to: ${used}` + RESET);
    }
    if (!results.length) {
      console.log(DIM + '  The catalog search needs every word to appear in an endpoint\'s text.' + RESET);
      console.log(DIM + '  Try fewer or more literal words, e.g. "gas" instead of "fuel cost".' + RESET);
      console.log(BRAND);
      process.exit(1);
    }
    for (const s of results) {
      const price = (Number(s.priceCents || 0) / 100).toFixed(s.priceCents < 100 ? 3 : 2);
      console.log(`  ${CYAN}${s.id}${RESET} ${DIM}${s.name}${RESET} | ${YELLOW}$${price}${RESET} | ${DIM}${(s.description || '').slice(0, 90)}${RESET}`);
    }
    console.log(DIM + `\n  → Try one free: minia2a trial ${results[0].id}` + RESET);
    console.log(DIM + '  → Details:     minia2a call <id>' + RESET);
    console.log(BRAND);
  } else if (cmd === 'stats') {
    const { data: d } = await fetch(BASE + '/api/stats');
    if (JSON_MODE) { console.log(JSON.stringify(d, null, 2)); return; }
    console.log(BOLD + '\n  minia2a.uk — Platform Stats' + RESET);
    console.log(DIM + '  Live data from ' + BASE + '/api/stats\n' + RESET);
    // Labels here are the whole point of this block: every field below is a
    // DIFFERENT denominator in /api/stats, and printing one under another's name
    // is a false claim about the platform (2026-11-04).
    //   · trials.totalUniqueUsers  — COUNT(DISTINCT ip) over trial rows with the
    //     three reserved probe digests excluded (handler_stats.go:185). It is a
    //     count of source ADDRESSES, not agents, not wallets, not users: one
    //     machine behind one IP contributes 1 no matter how many agents it runs,
    //     and a proxy pool contributes one per exit. It was printed as "N agents"
    //     and then as "N trial identities"; both named a thing the query never
    //     measured.
    //   · agents / registration.totalUsers — the number the site itself calls
    //     agents.
    //   · uptime — seconds since the gateway PROCESS started, reset on every
    //     restart. Flooring it to days printed "0 days" for a platform that had
    //     been serving for months, which reads as downtime.
    //   · totalRequests — inflated by bots and self-polling (the field's own
    //     note in /api/stats says so), so it is labelled as such.
    // Real adoption lives in realUsage, which is measured with our own wallets
    // and probe digests excluded — that is the honest demand line.
    const ru = d.realUsage || {};
    const fmtUptime = (s) => {
      const t = Number(s) || 0;
      const days = Math.floor(t / 86400), hours = Math.floor((t % 86400) / 3600), mins = Math.floor((t % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${mins}m`;
      return `${mins}m`;
    };
    console.log(`  ${BOLD}Services:${RESET}        ${GREEN}${(d.services || 0).toLocaleString()}${RESET}`);
    console.log(`  ${BOLD}Agents:${RESET}          ${(d.agents ?? d.registration?.totalUsers ?? 0).toLocaleString()} registered`);
    console.log(`  ${BOLD}Free Trials:${RESET}     ${CYAN}${(d.trials?.totalUsed || 0).toLocaleString()}${RESET} served (from ${(d.trials?.totalUniqueUsers || 0).toLocaleString()} distinct IPs)`);
    if (ru.agentTrialWallets7d !== undefined || ru.agentPayingWallets7d !== undefined) {
      const paying = ru.agentPayingWallets7d ?? 0, trialing = ru.agentTrialWallets7d ?? 0;
      console.log(`  ${BOLD}Trial wallets (7d):${RESET} ${trialing} · ${BOLD}Paying wallets (7d):${RESET} ${paying}`);
    }
    console.log(`  ${BOLD}Total Requests:${RESET}  ${(d.totalRequests || 0).toLocaleString()} ${DIM}(includes bot/self traffic)${RESET}`);
    console.log(`  ${BOLD}Settled on-chain:${RESET} ${d.realOnChain?.count || 0} payments, $${(d.realOnChain?.usdc || 0).toFixed(2)} USDC`);
    console.log(`  ${BOLD}Gateway uptime:${RESET}  ${fmtUptime(d.uptime)} ${DIM}(process, since last restart)${RESET}`);
    console.log(BRAND);
  } else if (cmd === 'trial') {
    const svcName = process.argv[3];
    const trialUsage = (exitCode) => {
      console.log(BOLD + '\n  Usage:' + RESET + ' minia2a trial <service-name> [--input \'{"key":"val"}\'] [--json]');
      console.log(DIM + '  Spends one of your 5 free trial calls. The wallet is signed locally —' + RESET);
      console.log(DIM + '  no registration, no payment, and the key never leaves this machine.\n' + RESET);
      console.log('  Example: minia2a trial x402-time');
      console.log('  Example: minia2a trial x402-gas --input \'{"chainId":1}\'');
      process.exit(exitCode);
    };
    // `--help` used to fall through to the catalog lookup and print
    // `Service "--help" not found`, which reads like a broken CLI to a first-time
    // user. A help flag is not a service name.
    if (!svcName || svcName === '--help' || svcName === '-h' || svcName === 'help') {
      trialUsage(svcName ? 0 : 1);
    }
    // Unknown flags used to be dropped on the floor: `trial X --param k=v` sent an
    // empty body, the endpoint answered 400 "…required", and nothing in the output
    // said the flag had been ignored. Refuse loudly instead of silently calling
    // with the wrong input.
    const TRIAL_FLAGS = new Set(['--input', '--json']);
    const extra = process.argv.slice(4);
    for (let i = 0; i < extra.length; i++) {
      const tok = extra[i];
      if (tok === '--input') { i++; continue; }        // its value is not a flag
      // TRIAL_FLAGS listed --json as accepted while this loop rejected every
      // dash-token, so `trial X --json` answered "Unknown option: --json" and
      // told the caller --json was accepted in the same breath. The branch that
      // prints machine-readable trial output was unreachable code. Test the set
      // the message already advertises, not a second hand-written list.
      if (TRIAL_FLAGS.has(tok)) continue;
      if (tok.startsWith('-')) {
        console.log(RED + `\n  Unknown option: ${tok}` + RESET);
        console.log(DIM + '  Accepted: --input \'{"key":"val"}\', --json' + RESET);
        trialUsage(2);
      }
    }
    const { data: d } = await fetch(BASE + '/api/services');
    const svc = (d.services || []).find(s => s.name === svcName || s.id === svcName);
    if (!svc) {
      console.log(RED + `\n  Service "${svcName}" not found.` + RESET);
      console.log(DIM + '  Try: minia2a search <words> or minia2a discover' + RESET);
      process.exit(1);
    }
    const endpoint = svc.url || svc.endpoint;
    if (!endpoint) {
      console.log(RED + `\n  Service "${svcName}" has no endpoint URL configured.` + RESET);
      process.exit(1);
    }

    let inputBody = {};
    const inputIdx = process.argv.indexOf('--input');
    if (inputIdx !== -1 && !process.argv[inputIdx + 1]) {
      console.log(RED + '  --input needs a JSON value: --input \'{"key":"val"}\'' + RESET);
      process.exit(2);
    }
    if (inputIdx !== -1) {
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
    // --json must emit nothing but JSON. These three lines printed unconditionally,
    // so `minia2a trial X --json | jq` choked on the ANSI-coloured preamble. The
    // call metadata they carried rides inside the `trial` object below instead.
    if (!JSON_MODE) {
      console.log(BOLD + `\n  🔬 Trial: ${svc.name}` + RESET + DIM + ` — ${svc.category}` + RESET);
      console.log(DIM + `  Wallet: ${wallet.address}` + RESET);
      console.log(DIM + `  Calling: ${url}` + RESET);
    }

    const { status, data: result, headers } = await post(url, inputBody, {
      'X-Wallet-Signature': signature,
      'X-Trial-Timestamp': ts,
    });
    const quota = trialQuota(headers);

    // Exit code contract (1.1.3): the trial succeeded iff the gateway answered
    // 200. Before this, the 402 path printed the refusal and returned without
    // setting an exit code, so `minia2a trial` exited 0 on a call it had just
    // reported as refused -- and every caller that gated on the exit code, e.g.
    // `if npx minia2a-cli trial X; then echo ok; fi`, reported a spent wallet as
    // a successful call. Every other failure path here already exits 1; this one
    // was the outlier. process.exitCode (not process.exit) so stdout still flushes.
    if (JSON_MODE) {
      // The allowance lives in response headers, not in the body. Machine-readable
      // output that dropped them left an agent no way to know how many free calls
      // it had left before it started paying. Body is preserved as-is; the quota
      // rides alongside it under its own key.
      const meta = { wallet: wallet.address, service: svc.id, ...(quota || {}) };
      const out = (result && typeof result === 'object' && !Array.isArray(result))
        ? { ...result, trial: meta }
        : { status, body: result, trial: meta };
      console.log(JSON.stringify(out, null, 2));
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
        // Scope matters here: the allowance is one bucket per wallet across the whole
        // catalog (gate.CheckTrial takes only the wallet). Saying "for this endpoint"
        // sent a developer to another endpoint expecting fresh calls, which the README
        // already denies ("not 5 per service").
        console.log(RED + '  This wallet has spent its 5 free trial calls (one allowance across the whole catalog).' + RESET);
      }
      console.log(DIM + `  ${msg || 'Payment required.'}` + RESET);
      const opt = Array.isArray(result.accepts) ? result.accepts[0] : null;
      if (opt) {
        console.log(`  ${BOLD}To pay per call:${RESET} ${YELLOW}$${(Number(opt.amount) / 1e6).toFixed(4)} USDC${RESET} ${DIM}on ${opt.network}${RESET}`);
      }
      // The old line here spelled out the rotation recipe ("any other wallet gets
      // its own 5 free calls", with the exact env var). Trials are gated per wallet
      // precisely to stop that; the CLI should not hand out the bypass at the moment
      // the caller is deciding whether to pay.
      if (exhausted) {
        console.log(DIM + '  Trials are per wallet, not per endpoint — switching endpoints will not add calls. Pay per call in USDC on Base to continue.' + RESET);
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
    // A 400 the gateway marks `inputError` is the caller's request shape, not the
    // endpoint failing. A first run with no --input lands here, and the field dump
    // above names the missing thing without saying what to do about it, so a
    // newcomer reads "this is broken" instead of "pass the field it just named".
    if (status === 400 && result && result.inputError && inputIdx === -1) {
      console.log(`\n  ${BOLD}Retry with the fields named above:${RESET}`);
      console.log(`    minia2a trial ${svcName} --input '{"<field>":"<value>"}'`);
    }
    if (quota && quota.remaining !== null && quota.max !== null) {
      console.log(DIM + `\n  💡 ${quota.remaining} of ${quota.max} free trial calls left for this wallet (one bucket across the whole catalog).` + RESET);
    } else {
      // No quota header: say what the number IS, so it is not read as the
      // caller's own spend. It is the endpoint's lifetime total.
      console.log(DIM + `\n  💡 ${svc.trialCount || 0} trial calls served by this endpoint so far. 5 free per wallet across the catalog.` + RESET);
    }
    console.log(BRAND);
    // Anything that is not a 200 is not a completed trial, whatever it printed.
    // Covers the 400/5xx paths the early sniff above does not special-case.
    if (status !== 200) process.exitCode = 1;
  } else if (cmd === 'wallet') {
    const wallet = loadWallet();
    const fromEnv = Boolean(process.env.MINIA2A_PRIVATE_KEY);
    // --json was documented as applying to "any command" and silently ignored
    // here: `wallet --json` printed the human prose, so a script could not read
    // the address it is supposed to pay from.
    if (JSON_MODE) {
      console.log(JSON.stringify({
        address: wallet.address,
        network: 'base',
        keySource: fromEnv ? 'env:MINIA2A_PRIVATE_KEY' : 'file',
        keyFile: fromEnv ? null : WALLET_FILE,
        trialAllowance: 5,
        docs: BASE + '/docs',
      }, null, 2));
      return;
    }
    console.log(BOLD + '\n  💳 Your wallet' + RESET);
    console.log(DIM + '  Self-custody, generated locally. minia2a never holds the key.\n' + RESET);
    console.log(`  ${BOLD}Address:${RESET}  ${CYAN}${wallet.address}${RESET}`);
    console.log(`  ${BOLD}Key file:${RESET} ${DIM}${fromEnv ? 'MINIA2A_PRIVATE_KEY (environment)' : WALLET_FILE + ' (chmod 600)'}${RESET}`);
    if (!fromEnv) console.log(DIM + '  Or set MINIA2A_PRIVATE_KEY to use a key you already hold.' + RESET);
    console.log('');
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
      console.log(`Service "${svcName}" not found. Try: minia2a search ${svcName}`);
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
    console.log(`  ${BOLD}minia2a search <words>${RESET} Find endpoints by intent [--limit N, --json]`);
    console.log(`  ${BOLD}minia2a trial <name>${RESET}    Spend a free trial call [--input '{"k":"v"}', --json]`);
    console.log(`  ${BOLD}minia2a call <name>${RESET}     Show service details [--json]`);
    console.log(`  ${BOLD}minia2a stats${RESET}          Live platform stats [--json]`);
    console.log(`  ${BOLD}minia2a wallet${RESET}         Your local wallet + how payment works [--json]`);
    console.log(`  ${BOLD}minia2a register${RESET}       List your own endpoint and earn USDC`);
    console.log(DIM + `\n  --json: machine-readable output for discover, search, call, stats, trial, wallet.` + RESET);
    console.log(DIM + `  ${BASE} — pay-per-call x402 APIs, USDC on Base, 5 free trials per wallet` + RESET);
  } else {
    console.log(RED + `\n  Unknown command: ${cmd}` + RESET);
    console.log(DIM + '  Try: minia2a help' + RESET);
    console.log(DIM + '  Quick start: minia2a discover' + RESET);
  }
}

main().catch(e => { console.error(RED + 'Error:' + RESET, e.message); process.exit(1); });
