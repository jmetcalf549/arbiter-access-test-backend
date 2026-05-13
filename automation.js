// Browserbase + Playwright automation for Arbiter with stealth + diagnostics.
// - Human-like input (typing speed, jittered delays, mouse movement)
// - Stealth context (UA, locale, timezone, viewport, navigator.webdriver mask)
// - Screenshots at every major step (returned as base64 data URLs)
// - Rich CAPTCHA detection (Cloudflare Turnstile / reCAPTCHA / hCaptcha / Arkose)
// - Optional manual CAPTCHA mode (pause + return live debugger URL)
// Never logs username/password. Always cleans up browser + session.

import { chromium } from "playwright-core";

const HARD_TIMEOUT_MS = 360_000; // 6min cap so manual CAPTCHA solving has room
const MANUAL_CAPTCHA_WAIT_MS = 180_000; // 3min manual-solve window

const ARBITER_LOGIN_URL =
  process.env.ARBITER_LOGIN_URL || "https://www1.arbitersports.com/Official/Login.aspx";
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

// ---------- Stealth ----------
async function applyStealth(context) {
  await context.addInitScript(() => {
    // navigator.webdriver
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
    // languages
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    // plugins length
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // chrome runtime
    // @ts-ignore
    window.chrome = window.chrome || { runtime: {} };
    // permissions query (notifications)
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (p) =>
        p && p.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);
    }
    // WebGL vendor/renderer spoof
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

// ---------- Human-like interactions ----------
async function humanMoveTo(page, locator) {
  try {
    const box = await locator.boundingBox();
    if (!box) return;
    const steps = rand(15, 30);
    const target = { x: box.x + box.width / 2 + rand(-4, 4), y: box.y + box.height / 2 + rand(-3, 3) };
    await page.mouse.move(target.x, target.y, { steps });
    await sleep(rand(80, 220));
  } catch {}
}
async function humanType(locator, text) {
  await locator.click({ delay: rand(40, 120) }).catch(() => {});
  for (const ch of text) {
    await locator.type(ch, { delay: rand(40, 140) });
    if (Math.random() < 0.07) await sleep(rand(100, 250));
  }
}

// ---------- CAPTCHA detection (rich) ----------
async function detectCaptchaDetailed(page) {
  const url = page.url();
  const lowerUrl = url.toLowerCase();
  const flags = {
    cloudflare_turnstile: false,
    recaptcha: false,
    hcaptcha: false,
    arkose: false,
    generic: false,
  };
  let matched = false;

  if (/captcha|challenge|cf-chl|cloudflare/.test(lowerUrl)) {
    flags.generic = true; matched = true;
    if (/turnstile|cloudflare/.test(lowerUrl)) flags.cloudflare_turnstile = true;
  }

  const html = (await page.content().catch(() => "")) || "";
  const lowerHtml = html.toLowerCase();
  if (/turnstile|cf-turnstile|challenges\.cloudflare\.com/.test(lowerHtml)) { flags.cloudflare_turnstile = true; matched = true; }
  if (/recaptcha|google\.com\/recaptcha|grecaptcha/.test(lowerHtml)) { flags.recaptcha = true; matched = true; }
  if (/hcaptcha|h-captcha|hcaptcha\.com/.test(lowerHtml)) { flags.hcaptcha = true; matched = true; }
  if (/arkoselabs|funcaptcha|enforcement\.arkoselabs/.test(lowerHtml)) { flags.arkose = true; matched = true; }
  if (!matched && /are you a human|verify you are human|please verify|security check|prove you'?re human/.test(lowerHtml)) {
    flags.generic = true; matched = true;
  }

  const iframeSrcs = await page.locator("iframe").evaluateAll(els => els.map(e => e.src || "")).catch(() => []);
  for (const src of iframeSrcs) {
    const s = (src || "").toLowerCase();
    if (/turnstile|challenges\.cloudflare/.test(s)) { flags.cloudflare_turnstile = true; matched = true; }
    if (/recaptcha/.test(s)) { flags.recaptcha = true; matched = true; }
    if (/hcaptcha/.test(s)) { flags.hcaptcha = true; matched = true; }
    if (/arkoselabs|funcaptcha/.test(s)) { flags.arkose = true; matched = true; }
  }

  return { detected: matched, flags, iframeSrcs, htmlSnippet: html.slice(0, 4000) };
}

function detectMfa(text) {
  return /(two[- ]factor|multi[- ]factor|verification code|authenticator|6-digit|verify your identity|enter the code)/i.test(text);
}
function detectInvalidCreds(text) {
  return /(invalid (username|password|credentials)|incorrect (username|password)|unable to sign in|login failed|username or password.*incorrect|username and password do not match)/i.test(text);
}

// ---------- Screenshots ----------
async function snap(page, label, screenshots, captureOnFailure) {
  if (!page) return;
  try {
    const buf = await page.screenshot({ fullPage: false, type: "jpeg", quality: 60, timeout: 8000 });
    screenshots[label] = `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch (e) {
    if (captureOnFailure) screenshots[`${label}__error`] = String(e?.message || e).slice(0, 200);
  }
}

// ---------- Selector helpers ----------
async function findUsernameLocator(page) {
  const sels = [
    'input[type="email"]',
    'input[name*="user" i]', 'input[id*="user" i]',
    'input[name*="email" i]', 'input[id*="email" i]',
    'input[name*="login" i]',
    'input[type="text"]:not([type="hidden"])',
  ];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.count().catch(() => 0)) return { loc, sel: s };
  }
  return null;
}
async function findPasswordLocator(page) {
  const sels = ['input[type="password"]', 'input[name*="password" i]', 'input[id*="password" i]'];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.count().catch(() => 0)) return { loc, sel: s };
  }
  return null;
}
async function findSubmitLocator(page) {
  const sels = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Sign In")', 'button:has-text("Log In")',
    'button:has-text("Login")', 'button:has-text("Continue")',
    'a:has-text("Sign In")',
  ];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.count().catch(() => 0)) return { loc, sel: s };
  }
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
  runId, username, password, browserbaseApiKey, browserbaseProjectId,
  manualCaptchaMode = false, captureFailureScreenshots = true,
  onUpdate, logger,
}) {
  const log = logger ?? console;
  const emit = (extra = {}) => {
    if (typeof onUpdate !== "function") return;
    try {
      onUpdate({
        ...baseResult,
        ...extra,
        current_step,
        manual_captcha_mode: !!manualCaptchaMode,
        duration_ms: Date.now() - startedAt,
      });
    } catch (e) { log.warn?.(`[automation] onUpdate failed: ${e?.message}`); }
  };
  const apiKey = browserbaseApiKey || process.env.BROWSERBASE_API_KEY;
  const projectId = browserbaseProjectId || process.env.BROWSERBASE_PROJECT_ID;

  const timings = {};
  const screenshots = {};
  const redirectChain = [];
  const debug = {
    stealth_mode_enabled: true,
    browser_connected: false,
    manual_captcha_mode: !!manualCaptchaMode,
  };
  const startedAt = Date.now();

  const baseResult = {
    status: "failed",
    current_step: "starting_browser",
    browser_connected: false,
    login_success: false,
    mfa_detected: false,
    captcha_detected: false,
    captcha_kinds: null,
    captcha_resolved: false,
    captcha_wait_active: false,
    remaining_wait_seconds: 0,
    manual_captcha_mode: !!manualCaptchaMode,
    invalid_credentials: false,
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

    // best-effort live debugger URL fetched synchronously up-front so the
    // first update emitted to the polling client already includes it.
    try {
      const dbg = await fetchLiveDebuggerUrl({ apiKey, sessionId, logger: log });
      if (dbg) {
        baseResult.debugger_url = dbg.debugger_url;
        baseResult.live_debugger_url = dbg.debugger_url;
        baseResult.browserbase_session_url = dbg.browserbase_session_url;
        debug.debugger_url = dbg.debugger_url;
        debug.debugger_fullscreen_url = dbg.debugger_fullscreen_url;
        log.log?.(`[browserbase] debugger url ready session=${sessionId}`);
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
      userAgent: ua,
      viewport: vp,
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
    });
    await applyStealth(context);
    page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(20_000);

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) redirectChain.push({ url: frame.url(), ts: Date.now() - startedAt });
    });

    if (timedOut) throw new Error("hard_timeout");

    // Open login page
    setStep("opening_login_page");
    const t2 = Date.now();
    await page.goto(ARBITER_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await sleep(rand(800, 1600));
    timings.arbiter_navigation_ms = Date.now() - t2;
    debug.login_url = page.url();
    baseResult.current_url = page.url();
    await snap(page, "initial_login_page", screenshots, captureFailureScreenshots);

    // Pre-submit CAPTCHA check
    let cap = await detectCaptchaDetailed(page);
    if (cap.detected) {
      await handleCaptcha("pre_submit", cap);
      if (!baseResult.captcha_resolved) {
        baseResult.current_url = page.url();
        baseResult.final_url = page.url();
        return finish({}, "detecting_mfa_captcha");
      }
    }
    if (timedOut) throw new Error("hard_timeout");

    // Find form
    setStep("entering_credentials");
    const userField = await findUsernameLocator(page);
    const passField = await findPasswordLocator(page);
    debug.user_selector = userField?.sel ?? null;
    debug.password_selector_used = passField ? "found" : "missing";
    if (!passField) {
      await snap(page, "login_failure", screenshots, captureFailureScreenshots);
      return finish({ error_type: "login_form_not_found",
        error_message: "Could not find a password field on the login page." }, "entering_credentials");
    }

    if (userField) {
      await humanMoveTo(page, userField.loc);
      await humanType(userField.loc, username);
      await snap(page, "after_username", screenshots, captureFailureScreenshots);
      await sleep(rand(250, 600));
    }
    await humanMoveTo(page, passField.loc);
    await humanType(passField.loc, password);
    await snap(page, "after_password", screenshots, captureFailureScreenshots);
    await sleep(rand(300, 700));

    // Re-check CAPTCHA before submit
    cap = await detectCaptchaDetailed(page);
    if (cap.detected) {
      await handleCaptcha("after_credentials", cap);
      if (!baseResult.captcha_resolved) {
        baseResult.current_url = page.url();
        baseResult.final_url = page.url();
        return finish({}, "detecting_mfa_captcha");
      }
    }

    setStep("submitting_login");
    const t3 = Date.now();
    const submit = await findSubmitLocator(page);
    if (submit) {
      await humanMoveTo(page, submit.loc);
      await submit.loc.click({ delay: rand(40, 120) }).catch(() => {});
      debug.submit_strategy = submit.sel;
    } else {
      await passField.loc.press("Enter").catch(() => {});
      debug.submit_strategy = "Enter";
    }
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
    timings.login_submit_ms = Date.now() - t3;

    debug.post_login_url = page.url();
    baseResult.current_url = page.url();
    debug.post_login_title = await page.title().catch(() => null);
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    debug.post_login_text_preview = bodyText.replace(/\s+/g, " ").slice(0, 2000);
    await snap(page, "post_login", screenshots, captureFailureScreenshots);

    if (timedOut) throw new Error("hard_timeout");

    setStep("checking_login_result");
    cap = await detectCaptchaDetailed(page);
    if (cap.detected) {
      await handleCaptcha("post_submit", cap);
      if (!baseResult.captcha_resolved) {
        baseResult.final_url = page.url();
        return finish({}, "detecting_mfa_captcha");
      }
    }
    const mfa = detectMfa(bodyText);
    const invalid = detectInvalidCreds(bodyText);
    const url = page.url().toLowerCase();
    const lowText = bodyText.toLowerCase();
    const looksAuthenticated =
      !/login|signin|sign-in/.test(url) ||
      /(logout|sign out|my schedule|my games|assignments|availability|blocks|calendar)/i.test(lowText);

    if (mfa) {
      await snap(page, "mfa_detected", screenshots, captureFailureScreenshots);
      return finish({ mfa_detected: true, error_type: "mfa_required",
        error_message: "MFA / two-factor verification required." }, "detecting_mfa_captcha");
    }
    if (invalid && !looksAuthenticated) {
      await snap(page, "login_failure", screenshots, captureFailureScreenshots);
      return finish({ invalid_credentials: true, error_type: "invalid_credentials",
        error_message: "Arbiter rejected the username or password." }, "checking_login_result");
    }
    if (!looksAuthenticated) {
      await snap(page, "login_failure", screenshots, captureFailureScreenshots);
      return finish({ error_type: "login_failed",
        error_message: "Could not confirm successful login." }, "checking_login_result");
    }

    baseResult.login_success = true;
    await snap(page, "login_success", screenshots, captureFailureScreenshots);

    // Discover post-login navigation links
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
          return {
            date: c[0] || "", time: c[1] || "", sport: c[2] || "",
            teams: c[3] || "", location: c[4] || "", role: c[5] || "",
            status: c[6] || "", raw_text: r.raw_text,
          };
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
          return {
            date: c[0] || "", start_time: c[1] || "", end_time: c[2] || "",
            reason: c.slice(3).join(" ") || "", raw_text: r.raw_text,
          };
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

  // ---- helpers that close over baseResult / debug / screenshots ----

  async function handleCaptcha(phase, cap) {
    baseResult.captcha_detected = true;
    baseResult.captcha_kinds = Object.entries(cap.flags).filter(([, v]) => v).map(([k]) => k);
    debug.captcha_phase = phase;
    debug.captcha_iframe_srcs = cap.iframeSrcs?.slice(0, 20);
    debug.captcha_html_snippet = cap.htmlSnippet;
    debug.captcha_url_before = page.url();
    log.log?.(`[captcha] detected phase=${phase} kinds=${(baseResult.captcha_kinds||[]).join(",") || "generic"} url=${page.url()}`);
    log.log?.(`[captcha] iframe_srcs=${JSON.stringify((cap.iframeSrcs || []).slice(0, 10))}`);
    try {
      const visibleText = await page.locator("body").innerText({ timeout: 3000 });
      debug.captcha_visible_text_preview = (visibleText || "").replace(/\s+/g, " ").slice(0, 2000);
      log.log?.(`[captcha] visible_text="${(visibleText || "").replace(/\s+/g, " ").slice(0, 200)}"`);
    } catch {}
    await snap(page, `captcha_${phase}`, screenshots, true);

    // Make sure we have the live debugger URL for manual solving
    if (!baseResult.debugger_url) {
      const dbg = await fetchLiveDebuggerUrl({ apiKey, sessionId, logger: log });
      if (dbg) {
        baseResult.debugger_url = dbg.debugger_url;
        baseResult.live_debugger_url = dbg.debugger_url;
        baseResult.browserbase_session_url = dbg.browserbase_session_url;
        debug.debugger_url = dbg.debugger_url;
      }
    }

    if (!manualCaptchaMode) {
      baseResult.error_type = "captcha_detected";
      baseResult.error_message = `CAPTCHA detected (${(baseResult.captcha_kinds || []).join(", ") || "generic"}) at ${phase}. Enable manual mode to solve via the live debugger.`;
      emit();
      return;
    }

    // Manual mode: surface "waiting_for_manual_captcha" to the polling
    // client and keep the browser session alive while the user solves the
    // CAPTCHA in the live Browserbase debugger window. Re-check every 2s.
    const startWait = Date.now();
    debug.manual_captcha_started_at_ms = Date.now() - startedAt;
    baseResult.captcha_wait_active = true;
    baseResult.status = "waiting_for_manual_captcha";
    baseResult.error_type = null;
    baseResult.error_message = null;
    log.log?.(`[captcha] manual mode active, waiting up to ${MANUAL_CAPTCHA_WAIT_MS}ms (debugger=${baseResult.debugger_url || "none"})`);
    emit({ remaining_wait_seconds: Math.ceil(MANUAL_CAPTCHA_WAIT_MS / 1000) });

    while (Date.now() - startWait < MANUAL_CAPTCHA_WAIT_MS) {
      await sleep(2000);
      if (timedOut) break;
      const remaining = Math.max(0, Math.ceil((MANUAL_CAPTCHA_WAIT_MS - (Date.now() - startWait)) / 1000));
      baseResult.remaining_wait_seconds = remaining;
      const recheck = await detectCaptchaDetailed(page).catch(() => ({ detected: true }));
      if (!recheck.detected) {
        baseResult.captcha_resolved = true;
        baseResult.captcha_wait_active = false;
        baseResult.remaining_wait_seconds = 0;
        debug.manual_captcha_resolved_in_ms = Date.now() - startWait;
        debug.captcha_url_after = page.url();
        log.log?.(`[captcha] resolved manually in ${Date.now() - startWait}ms url=${page.url()}`);
        await snap(page, `captcha_${phase}_resolved`, screenshots, captureFailureScreenshots);
        emit();
        return;
      }
      emit({ remaining_wait_seconds: remaining });
    }
    baseResult.captcha_wait_active = false;
    baseResult.remaining_wait_seconds = 0;
    baseResult.error_type = "captcha_unresolved";
    baseResult.error_message = `Manual CAPTCHA window (${MANUAL_CAPTCHA_WAIT_MS}ms) elapsed without resolution at ${phase}.`;
    log.log?.(`[captcha] manual window elapsed unresolved at ${phase}`);
    emit();
  }

  function finish(overrides, step) {
    timings.total_duration_ms = Date.now() - startedAt;
    if (page) {
      try { baseResult.final_url = baseResult.final_url || page.url(); } catch {}
      try { baseResult.current_url = page.url(); } catch {}
    }
    baseResult.captcha_wait_active = false;
    baseResult.remaining_wait_seconds = 0;
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
