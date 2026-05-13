// Browserbase + Playwright automation for Arbiter.
// Logs into Arbiter, then attempts to discover and extract games and blocks.
// Never logs username/password. Always cleans up browser + session.

import { chromium } from "playwright-core";

const HARD_TIMEOUT_MS = 90_000;
const ARBITER_LOGIN_URL = process.env.ARBITER_LOGIN_URL || "https://www1.arbitersports.com/Official/Login.aspx";
const ARBITER_SCHEDULE_URL = process.env.ARBITER_SCHEDULE_URL || null;
const ARBITER_BLOCKS_URL = process.env.ARBITER_BLOCKS_URL || null;

const STEALTH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (url.searchParams.has("apiKey")) url.searchParams.set("apiKey", "[REDACTED]");
    return url.toString();
  } catch { return "[unparseable url]"; }
}

async function createBrowserbaseSession({ apiKey, projectId, logger }) {
  const t0 = Date.now();
  const res = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey },
    body: JSON.stringify({ projectId }),
  });
  const text = await res.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  logger.log?.(`[browserbase] create status=${res.status} ms=${Date.now() - t0}`);
  if (!res.ok) { const e = new Error(`browserbase_${res.status}`); e.status = res.status; e.body = text.slice(0,500); throw e; }
  if (!parsed) throw new Error("invalid_browserbase_response");
  const sessionId = parsed.id ?? parsed.sessionId ?? parsed.session_id;
  if (!sessionId) throw new Error("missing_browserbase_session_id");
  const directWs = parsed.connectUrl ?? parsed.connect_url ?? parsed.wsUrl ?? parsed.ws_url
    ?? parsed.endpointURL ?? parsed.endpointUrl ?? parsed.browserWSEndpoint ?? null;
  const wsUrl = directWs ?? `wss://connect.browserbase.com?apiKey=${encodeURIComponent(apiKey)}&sessionId=${encodeURIComponent(sessionId)}`;
  return { sessionId, wsUrl, source: directWs ? "direct" : "constructed" };
}

async function releaseBrowserbaseSession({ apiKey, sessionId, logger }) {
  if (!sessionId) return;
  try {
    await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey },
      body: JSON.stringify({ status: "REQUEST_RELEASE" }),
    });
  } catch (e) { logger.warn?.(`[browserbase] release failed: ${e?.message}`); }
}

async function detectCaptcha(page) {
  const url = page.url().toLowerCase();
  if (/captcha|hcaptcha|recaptcha|cloudflare|challenge/.test(url)) return true;
  const html = (await page.content().catch(() => "")).toLowerCase();
  if (/captcha|recaptcha|hcaptcha|are you a human|verify you are human/.test(html)) return true;
  const iframeSrc = await page.locator('iframe').evaluateAll(els => els.map(e => e.src || "")).catch(() => []);
  return iframeSrc.some((s) => /recaptcha|hcaptcha|captcha/i.test(s));
}

function detectMfa(text) {
  return /(two[- ]factor|multi[- ]factor|verification code|authenticator|6-digit|verify your identity|enter the code)/i.test(text);
}
function detectInvalidCreds(text) {
  return /(invalid (username|password|credentials)|incorrect (username|password)|unable to sign in|login failed|username or password.*incorrect|username and password do not match)/i.test(text);
}

async function tryFillUsername(page, username) {
  const sels = [
    'input[type="email"]',
    'input[name*="user" i]', 'input[id*="user" i]',
    'input[name*="email" i]', 'input[id*="email" i]',
    'input[name*="login" i]',
    'input[type="text"]:not([type="hidden"])',
  ];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.count().catch(() => 0)) {
      try { await loc.fill(username, { timeout: 3000 }); return s; } catch {}
    }
  }
  return null;
}
async function tryFillPassword(page, password) {
  const sels = ['input[type="password"]', 'input[name*="password" i]', 'input[id*="password" i]'];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.count().catch(() => 0)) {
      try { await loc.fill(password, { timeout: 3000 }); return s; } catch {}
    }
  }
  return null;
}
async function tryClickSubmit(page) {
  const sels = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Sign In")', 'button:has-text("Log In")',
    'button:has-text("Login")', 'button:has-text("Continue")',
    'a:has-text("Sign In")',
  ];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.count().catch(() => 0)) {
      try { await loc.click({ timeout: 3000 }); return s; } catch {}
    }
  }
  // Fallback: press Enter on password field
  try { await page.locator('input[type="password"]').first().press("Enter"); return "Enter"; } catch {}
  return null;
}

async function discoverNavLinks(page) {
  const keywords = ["schedule", "games", "assignments", "blocks", "availability", "calendar", "block"];
  return await page.evaluate((kws) => {
    const out = [];
    const els = Array.from(document.querySelectorAll("a, button"));
    for (const el of els) {
      const text = (el.innerText || el.textContent || "").trim();
      if (!text) continue;
      const low = text.toLowerCase();
      if (!kws.some((k) => low.includes(k))) continue;
      const href = el.tagName === "A" ? el.href : null;
      out.push({ text: text.slice(0, 80), href, tag: el.tagName.toLowerCase() });
      if (out.length >= 30) break;
    }
    return out;
  }, keywords).catch(() => []);
}

async function findLinkByKeywords(page, keywords) {
  return await page.evaluate((kws) => {
    const els = Array.from(document.querySelectorAll("a"));
    for (const el of els) {
      const t = (el.innerText || "").trim().toLowerCase();
      if (!t) continue;
      if (kws.some((k) => t.includes(k))) return el.href || null;
    }
    return null;
  }, keywords).catch(() => null);
}

function rowsFromTables() {
  return Array.from(document.querySelectorAll("table")).flatMap((tbl) => {
    const rows = Array.from(tbl.querySelectorAll("tbody tr, tr"));
    return rows.map((tr) => {
      const cells = Array.from(tr.querySelectorAll("td, th")).map((td) => (td.innerText || "").trim());
      return { cells, raw_text: cells.join(" | ") };
    }).filter((r) => r.cells.length > 1 && r.raw_text.length > 0);
  });
}

async function extractGames(page) {
  const data = await page.evaluate(() => {
    const fromTables = (() => {
      return Array.from(document.querySelectorAll("table")).flatMap((tbl) => {
        const rows = Array.from(tbl.querySelectorAll("tbody tr, tr"));
        return rows.map((tr) => {
          const cells = Array.from(tr.querySelectorAll("td, th")).map((td) => (td.innerText || "").trim());
          return { cells, raw_text: cells.join(" | ") };
        }).filter((r) => r.cells.length > 1 && r.raw_text.length > 0);
      });
    })();
    if (fromTables.length) return { source: "table", rows: fromTables };
    const cardSel = '.game, .assignment, .schedule, .event, [role="row"]';
    const cards = Array.from(document.querySelectorAll(cardSel)).map((el) => ({
      cells: [], raw_text: (el.innerText || "").trim().slice(0, 400),
    })).filter((r) => r.raw_text);
    return { source: cards.length ? "cards" : "none", rows: cards };
  }).catch(() => ({ source: "none", rows: [] }));

  const games = data.rows.map((r) => {
    const c = r.cells;
    return {
      date: c[0] || "",
      time: c[1] || "",
      sport: c[2] || "",
      teams: c[3] || "",
      location: c[4] || "",
      role: c[5] || "",
      status: c[6] || "",
      raw_text: r.raw_text,
    };
  });
  return { games, source: data.source };
}

async function extractBlocks(page) {
  const data = await page.evaluate(() => {
    const fromTables = Array.from(document.querySelectorAll("table")).flatMap((tbl) => {
      const rows = Array.from(tbl.querySelectorAll("tbody tr, tr"));
      return rows.map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td, th")).map((td) => (td.innerText || "").trim());
        return { cells, raw_text: cells.join(" | ") };
      }).filter((r) => r.cells.length > 1 && r.raw_text.length > 0);
    });
    if (fromTables.length) return { source: "table", rows: fromTables };
    const cardSel = '.block, .availability, .calendar, .unavailable, [role="row"]';
    const cards = Array.from(document.querySelectorAll(cardSel)).map((el) => ({
      cells: [], raw_text: (el.innerText || "").trim().slice(0, 400),
    })).filter((r) => r.raw_text);
    return { source: cards.length ? "cards" : "none", rows: cards };
  }).catch(() => ({ source: "none", rows: [] }));

  const blocks = data.rows.map((r) => {
    const c = r.cells;
    return {
      date: c[0] || "",
      start_time: c[1] || "",
      end_time: c[2] || "",
      reason: c.slice(3).join(" ") || "",
      raw_text: r.raw_text,
    };
  });
  return { blocks, source: data.source };
}

export async function runArbiterAutomation({
  runId, username, password, browserbaseApiKey, browserbaseProjectId, logger,
}) {
  const log = logger ?? console;
  const apiKey = browserbaseApiKey || process.env.BROWSERBASE_API_KEY;
  const projectId = browserbaseProjectId || process.env.BROWSERBASE_PROJECT_ID;

  const timings = {};
  const debug = { stealth_mode_enabled: true, browser_connected: false };
  const startedAt = Date.now();

  const baseResult = {
    status: "failed",
    current_step: "starting_browser",
    browser_connected: false,
    login_success: false,
    mfa_detected: false,
    captcha_detected: false,
    invalid_credentials: false,
    schedule_found: false,
    blocks_found: false,
    games_found: 0,
    blocks_found_count: 0,
    games: [],
    blocks: [],
    discovered_links: [],
    error_type: null,
    error_message: null,
    duration_ms: 0,
    debug,
    timings,
  };

  if (!apiKey || !projectId) {
    return {
      ...baseResult,
      error_type: "browserbase_credentials_missing",
      error_message: "BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID not set.",
      duration_ms: Date.now() - startedAt,
    };
  }

  let browser = null, context = null, page = null, sessionId = null, timedOut = false;
  const hardTimer = setTimeout(() => { timedOut = true; }, HARD_TIMEOUT_MS);
  let current_step = "starting_browser";
  const setStep = (s) => { current_step = s; };

  try {
    setStep("starting_browser");
    const t1 = Date.now();
    const session = await createBrowserbaseSession({ apiKey, projectId, logger: log });
    sessionId = session.sessionId;
    debug.browserbase_session_id = sessionId;
    debug.browserbase_connect_url_sanitized = sanitizeUrl(session.wsUrl);
    timings.browserbase_connect_ms = Date.now() - t1;

    browser = await chromium.connectOverCDP(session.wsUrl, { timeout: 30_000 });
    debug.browser_connected = true;
    baseResult.browser_connected = true;

    const existing = browser.contexts();
    context = existing.length ? existing[0] : await browser.newContext({
      userAgent: STEALTH_USER_AGENT,
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
    });
    page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(20_000);
    if (timedOut) throw new Error("hard_timeout");

    // Open login page
    setStep("opening_login_page");
    const t2 = Date.now();
    await page.goto(ARBITER_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await sleep(rand(600, 1200));
    timings.arbiter_navigation_ms = Date.now() - t2;
    debug.login_url = page.url();

    if (await detectCaptcha(page)) {
      return finish({ captcha_detected: true, error_type: "captcha_detected",
        error_message: "CAPTCHA presented before login could be submitted." }, "detecting_mfa_captcha");
    }
    if (timedOut) throw new Error("hard_timeout");

    // Fill credentials
    setStep("entering_credentials");
    const userSel = await tryFillUsername(page, username);
    await sleep(rand(150, 400));
    const passSel = await tryFillPassword(page, password);
    await sleep(rand(150, 400));
    debug.user_selector = userSel; debug.password_selector_used = passSel ? "found" : "missing";
    if (!passSel) {
      return finish({ error_type: "login_form_not_found",
        error_message: "Could not find a password field on the login page." }, "entering_credentials");
    }

    setStep("submitting_login");
    const t3 = Date.now();
    const submitUsed = await tryClickSubmit(page);
    debug.submit_strategy = submitUsed;
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
    timings.login_submit_ms = Date.now() - t3;

    debug.post_login_url = page.url();
    debug.post_login_title = await page.title().catch(() => null);
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    debug.post_login_text_preview = bodyText.replace(/\s+/g, " ").slice(0, 2000);

    if (timedOut) throw new Error("hard_timeout");

    setStep("checking_login_result");
    if (await detectCaptcha(page)) {
      return finish({ captcha_detected: true, error_type: "captcha_detected",
        error_message: "CAPTCHA presented after submitting login." }, "detecting_mfa_captcha");
    }
    const mfa = detectMfa(bodyText);
    const invalid = detectInvalidCreds(bodyText);
    const url = page.url().toLowerCase();
    const lowText = bodyText.toLowerCase();
    const looksAuthenticated =
      !/login|signin|sign-in/.test(url) ||
      /(logout|sign out|my schedule|my games|assignments|availability|blocks|calendar)/i.test(lowText);

    if (mfa) {
      return finish({ mfa_detected: true, error_type: "mfa_required",
        error_message: "MFA / two-factor verification required." }, "detecting_mfa_captcha");
    }
    if (invalid && !looksAuthenticated) {
      return finish({ invalid_credentials: true, error_type: "invalid_credentials",
        error_message: "Arbiter rejected the username or password." }, "checking_login_result");
    }
    if (!looksAuthenticated) {
      return finish({ error_type: "login_failed",
        error_message: "Could not confirm successful login." }, "checking_login_result");
    }

    baseResult.login_success = true;

    // Discover post-login navigation links
    setStep("looking_for_schedule");
    baseResult.discovered_links = await discoverNavLinks(page);
    debug.discovered_link_count = baseResult.discovered_links.length;

    // Schedule
    const tExt = Date.now();
    let scheduleUrl = ARBITER_SCHEDULE_URL || await findLinkByKeywords(page, ["schedule", "games", "assignments"]);
    if (scheduleUrl) {
      try {
        await page.goto(scheduleUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await sleep(rand(700, 1500));
        setStep("extracting_schedule");
        const { games, source } = await extractGames(page);
        baseResult.games = games;
        baseResult.games_found = games.length;
        baseResult.schedule_found = games.length > 0;
        debug.schedule_url = page.url();
        debug.schedule_extraction_source = source;
      } catch (e) { debug.schedule_error = e?.message?.slice(0, 200); }
    } else {
      debug.schedule_url_not_found = true;
    }

    // Blocks
    setStep("looking_for_blocks");
    let blocksUrl = ARBITER_BLOCKS_URL || await findLinkByKeywords(page, ["block", "availability", "calendar"]);
    if (blocksUrl) {
      try {
        await page.goto(blocksUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await sleep(rand(700, 1500));
        setStep("extracting_blocks");
        const { blocks, source } = await extractBlocks(page);
        baseResult.blocks = blocks;
        baseResult.blocks_found_count = blocks.length;
        baseResult.blocks_found = blocks.length > 0;
        debug.blocks_url = page.url();
        debug.blocks_extraction_source = source;
      } catch (e) { debug.blocks_error = e?.message?.slice(0, 200); }
    } else {
      debug.blocks_url_not_found = true;
    }
    timings.extraction_ms = Date.now() - tExt;

    const status =
      baseResult.schedule_found && baseResult.blocks_found ? "success" :
      baseResult.login_success ? "partial_success" : "failed";

    return finish({ status }, "returning_results");
  } catch (err) {
    const isTimeout = timedOut || err?.message === "hard_timeout";
    return finish({
      error_type: isTimeout ? "hard_timeout" : (err?.code || "automation_error"),
      error_message: isTimeout
        ? `Automation aborted after ${HARD_TIMEOUT_MS}ms hard timeout.`
        : (err?.message ?? "Unknown automation error"),
    }, current_step || "crashed");
  } finally {
    clearTimeout(hardTimer);
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
    await releaseBrowserbaseSession({ apiKey, sessionId, logger: log });
    log.log?.(`[arbiter] finished runId=${runId ?? "none"} duration=${Date.now() - startedAt}ms`);
  }

  function finish(overrides, step) {
    timings.total_duration_ms = Date.now() - startedAt;
    const out = { ...baseResult, ...overrides, current_step: step, duration_ms: timings.total_duration_ms };
    if (!out.status || out.status === "failed") {
      if (out.login_success && (out.schedule_found || out.blocks_found)) out.status = "partial_success";
      else if (out.login_success && out.schedule_found && out.blocks_found) out.status = "success";
      else if (out.error_type) out.status = "failed";
    }
    return out;
  }
}
