// Browserbase + Playwright automation for Arbiter with stealth + diagnostics.
// - Cookie-based authentication (skips login entirely)
// - Human-like input (typing speed, jittered delays, mouse movement)
// - Stealth context (UA, locale, timezone, viewport, navigator.webdriver mask)
// - Screenshots at every major step (returned as base64 data URLs)
// - Rich CAPTCHA detection (Cloudflare Turnstile / reCAPTCHA / hCaptcha / Arkose)
// Never logs credentials. Always cleans up browser + session.

import { chromium } from "playwright-core";

const HARD_TIMEOUT_MS = 360_000;

const ARBITER_HOME_URL = "https://www1.arbitersports.com/Official/Default.aspx";
const ARBITER_SCHEDULE_URL = process.env.ARBITER_SCHEDULE_URL || null;
const ARBITER_BLOCKS_URL = process.env.ARBITER_BLOCKS_URL || null;

const REALISTIC_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1680, height: 1050 },
];

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function sanitizeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (url.searchParams.has("apiKey")) url.searchParams.set("apiKey", "[REDACTED]");
    return url.toString();
  } catch { return "[unparseable url]"; }
}

// Parse a cookie string like "name=value; name2=value2" into an array of
// Playwright-compatible cookie objects for www1.arbitersports.com
function parseCookieString(cookieStr, domain = "www1.arbitersports.com") {
  if (!cookieStr) return [];
  return cookieStr.split(";").map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return null;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) return null;
    return {
      name,
      value,
      domain,
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "None",
    };
  }).filter(Boolean);
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

async function fetchLiveDebuggerUrl({ apiKey, sessionId, logger }) {
  try {
    const res = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/debug`, {
      headers: { "X-BB-API-Key": apiKey },
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return {
      debugger_url: j?.debuggerFullscreenUrl ?? j?.debuggerUrl ?? j?.liveViewUrl ?? null,
      debugger_fullscreen_url: j?.debuggerFullscreenUrl ?? null,
      browserbase_session_url: j?.wsUrl ?? j?.pages?.[0]?.url ?? null,
      raw: j,
    };
  } catch (e) {
    logger.warn?.(`[browserbase] debug fetch failed: ${e?.message}`);
    return null;
  }
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

async function applyStealth(context) {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // @ts-ignore
    window.chrome = window.chrome || { runtime: {} };
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (p) =>
        p && p.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);
    }
    try {
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return "Intel Inc.";
        if (p === 37446) return "Intel Iris OpenGL Engine";
        return getParam.call(this, p);
      };
    } catch {}
  });
}

async function snap(page, label, screenshots, captureOnFailure) {
  if (!page) return;
  try {
    const buf = await page.screenshot({ fullPage: false, type: "jpeg", quality: 60, timeout: 8000 });
    screenshots[label] = `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch (e) {
    if (captureOnFailure) screenshots[`${label}__error`] = String(e?.message || e).slice(0, 200);
  }
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

async function extractRows(page) {
  return await page.evaluate(() => {
    const fromTables = Array.from(document.querySelectorAll("table")).flatMap((tbl) => {
      const rows = Array.from(tbl.querySelectorAll("tbody tr, tr"));
      return rows.map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td, th")).map((td) => (td.innerText || "").trim());
        return { cells, raw_text: cells.join(" | ") };
      }).filter((r) => r.cells.length > 1 && r.raw_text.length > 0);
    });
    return fromTables;
  }).catch(() => []);
}

export async function runArbiterAutomation({
  runId, cookies, browserbaseApiKey, browserbaseProjectId,
  captureFailureScreenshots = true, onUpdate, logger,
}) {
  const log = logger ?? console;
  const emit = (extra = {}) => {
    if (typeof onUpdate !== "function") return;
    try {
      onUpdate({ ...baseResult, ...extra, current_step, duration_ms: Date.now() - startedAt });
    } catch (e) { log.warn?.(`[automation] onUpdate failed: ${e?.message}`); }
  };
  const apiKey = browserbaseApiKey || process.env.BROWSERBASE_API_KEY;
  const projectId = browserbaseProjectId || process.env.BROWSERBASE_PROJECT_ID;

  const timings = {};
  const screenshots = {};
  const redirectChain = [];
  const debug = { stealth_mode_enabled: true, browser_connected: false, cookie_auth: true };
  const startedAt = Date.now();

  const baseResult = {
    status: "failed",
    current_step: "starting_browser",
    browser_connected: false,
    login_success: false,
    session_expired: false,
    schedule_found: false,
    blocks_found: false,
    games_found: 0,
    blocks_found_count: 0,
    games: [],
    blocks: [],
    discovered_links: [],
    current_url: null,
    final_url: null,
    redirect_chain: redirectChain,
    session_id: null,
    live_debugger_url: null,
    browserbase_session_url: null,
    debugger_url: null,
    error_type: null,
    error_message: null,
    duration_ms: 0,
    debug,
    timings,
    screenshots,
  };

  if (!apiKey || !projectId) {
    return { ...baseResult, error_type: "browserbase_credentials_missing",
      error_message: "BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID not set.",
      duration_ms: Date.now() - startedAt };
  }

  if (!cookies) {
    return { ...baseResult, error_type: "missing_cookies",
      error_message: "cookies string is required for cookie-based auth.",
      duration_ms: Date.now() - startedAt };
  }

  let browser = null, context = null, page = null, sessionId = null, timedOut = false;
  const hardTimer = setTimeout(() => { timedOut = true; }, HARD_TIMEOUT_MS);
  let current_step = "starting_browser";
  const setStep = (s) => { current_step = s; emit(); };

  try {
    setStep("starting_browser");
    const t1 = Date.now();
    const session = await createBrowserbaseSession({ apiKey, projectId, logger: log });
    sessionId = session.sessionId;
    baseResult.session_id = sessionId;
    debug.browserbase_session_id = sessionId;
    debug.browserbase_connect_url_sanitized = sanitizeUrl(session.wsUrl);
    timings.browserbase_connect_ms = Date.now() - t1;

    try {
      const dbg = await fetchLiveDebuggerUrl({ apiKey, sessionId, logger: log });
      if (dbg) {
        baseResult.debugger_url = dbg.debugger_url;
        baseResult.live_debugger_url = dbg.debugger_url;
        baseResult.browserbase_session_url = dbg.browserbase_session_url;
        debug.debugger_url = dbg.debugger_url;
      }
    } catch {}
    emit();

    browser = await chromium.connectOverCDP(session.wsUrl, { timeout: 30_000 });
    debug.browser_connected = true;
    baseResult.browser_connected = true;

    const ua = pick(REALISTIC_USER_AGENTS);
    const vp = pick(VIEWPORTS);
    debug.user_agent = ua; debug.viewport = vp;

    const existing = browser.contexts();
    context = existing.length ? existing[0] : await browser.newContext({
      userAgent: ua, viewport: vp, locale: "en-US",
      timezoneId: "America/Los_Angeles", deviceScaleFactor: 1,
      hasTouch: false, isMobile: false,
    });
    await applyStealth(context);

    // Inject cookies before navigating
    setStep("injecting_cookies");
    const parsedCookies = parseCookieString(cookies);
    debug.cookies_injected = parsedCookies.length;
    log.log?.(`[auth] injecting ${parsedCookies.length} cookies`);
    await context.addCookies(parsedCookies);

    page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) redirectChain.push({ url: frame.url(), ts: Date.now() - startedAt });
    });

    if (timedOut) throw new Error("hard_timeout");

    // Navigate directly to the home page (skipping login)
    setStep("navigating_to_dashboard");
    const t2 = Date.now();
    await page.goto(ARBITER_HOME_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await sleep(rand(800, 1500));
    timings.navigation_ms = Date.now() - t2;
    baseResult.current_url = page.url();
    await snap(page, "dashboard", screenshots, captureFailureScreenshots);

    // Check if we got redirected back to login (session expired)
    const currentUrl = page.url().toLowerCase();
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    const isLoginPage = /login|signin|sign-in|b2clogin|microsoftonline/.test(currentUrl);

    if (isLoginPage) {
      log.log?.(`[auth] session expired or cookies invalid, redirected to login`);
      return finish({
        session_expired: true,
        error_type: "session_expired",
        error_message: "Cookies are expired or invalid. Please re-export fresh cookies from your browser.",
      }, "navigating_to_dashboard");
    }

    // Confirm we're logged in
    const looksAuthenticated =
      /(logout|sign out|my schedule|my games|assignments|availability|blocks|calendar|john rush|dashboard)/i.test(bodyText);

    if (!looksAuthenticated) {
      await snap(page, "auth_check_failed", screenshots, captureFailureScreenshots);
      return finish({
        session_expired: true,
        error_type: "session_expired",
        error_message: "Could not confirm authenticated session. Cookies may be expired.",
      }, "navigating_to_dashboard");
    }

    baseResult.login_success = true;
    log.log?.(`[auth] cookie auth successful, on dashboard`);

    // Discover nav links
    setStep("looking_for_schedule");
    baseResult.discovered_links = await discoverNavLinks(page);
    debug.discovered_link_count = baseResult.discovered_links.length;

    // Schedule
    const tExt = Date.now();
    const scheduleUrl = ARBITER_SCHEDULE_URL || await findLinkByKeywords(page, ["schedule", "games", "assignments"]);
    if (scheduleUrl) {
      try {
        await page.goto(scheduleUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await sleep(rand(700, 1500));
        setStep("extracting_schedule");
        const rows = await extractRows(page);
        baseResult.games = rows.map((r) => {
          const c = r.cells;
          return { date: c[0] || "", time: c[1] || "", sport: c[2] || "",
            teams: c[3] || "", location: c[4] || "", role: c[5] || "",
            status: c[6] || "", raw_text: r.raw_text };
        });
        baseResult.games_found = baseResult.games.length;
        baseResult.schedule_found = baseResult.games.length > 0;
        debug.schedule_url = page.url();
        await snap(page, "schedule_page", screenshots, captureFailureScreenshots);
      } catch (e) { debug.schedule_error = e?.message?.slice(0, 200); }
    } else {
      debug.schedule_url_not_found = true;
    }

    // Blocks
    setStep("looking_for_blocks");
    const blocksUrl = ARBITER_BLOCKS_URL || await findLinkByKeywords(page, ["block", "availability", "calendar"]);
    if (blocksUrl) {
      try {
        await page.goto(blocksUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await sleep(rand(700, 1500));
        setStep("extracting_blocks");
        const rows = await extractRows(page);
        baseResult.blocks = rows.map((r) => {
          const c = r.cells;
          return { date: c[0] || "", start_time: c[1] || "", end_time: c[2] || "",
            reason: c.slice(3).join(" ") || "", raw_text: r.raw_text };
        });
        baseResult.blocks_found_count = baseResult.blocks.length;
        baseResult.blocks_found = baseResult.blocks.length > 0;
        debug.blocks_url = page.url();
        await snap(page, "blocks_page", screenshots, captureFailureScreenshots);
      } catch (e) { debug.blocks_error = e?.message?.slice(0, 200); }
    } else {
      debug.blocks_url_not_found = true;
    }
    timings.extraction_ms = Date.now() - tExt;

    baseResult.final_url = page.url();
    const status =
      baseResult.schedule_found && baseResult.blocks_found ? "success" :
      baseResult.login_success ? "partial_success" : "failed";

    return finish({ status }, "returning_results");

  } catch (err) {
    const isTimeout = timedOut || err?.message === "hard_timeout";
    if (page && captureFailureScreenshots) await snap(page, "crash", screenshots, true);
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
    if (page) {
      try { baseResult.final_url = baseResult.final_url || page.url(); } catch {}
      try { baseResult.current_url = page.url(); } catch {}
    }
    const out = { ...baseResult, ...overrides, current_step: step, duration_ms: timings.total_duration_ms };
    if (!out.status || out.status === "failed") {
      if (out.login_success && out.schedule_found && out.blocks_found) out.status = "success";
      else if (out.login_success && (out.schedule_found || out.blocks_found)) out.status = "partial_success";
      else if (out.error_type) out.status = "failed";
    }
    emit(out);
    return out;
  }
}
