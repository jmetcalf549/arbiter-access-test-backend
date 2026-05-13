import express from "express";
import cors from "cors";
import { chromium } from "playwright-core";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Arbiter Access Test Backend"
  });
});

app.post("/api/arbiter/test-login", async (req, res) => {
  const result = {
    status: "failed",
    current_step: "starting",
    browser_connected: false,
    error_type: null,
    error_message: null
  };

  try {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;

    if (!apiKey || !projectId) {
      result.error_type = "missing_browserbase_config";
      result.error_message = "Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID";
      return res.status(500).json(result);
    }

    result.current_step = "creating_browserbase_session";

    const sessionResponse = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "X-BB-API-Key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        projectId
      })
    });

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text();
      result.error_type = "browserbase_session_create_failed";
      result.error_message = errorText;
      return res.status(500).json(result);
    }

    const session = await sessionResponse.json();

    result.current_step = "connecting_playwright";

    const browser = await chromium.connectOverCDP(session.connectUrl);

    result.browser_connected = true;

    const page = await browser.newPage();

    result.current_step = "opening_test_page";

    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });

    const title = await page.title();

    await browser.close();

    result.status = "success";
    result.current_step = "browser_test_complete";
    result.page_title = title;

    return res.json(result);
  } catch (error) {
    result.error_type = "browser_error";
    result.error_message = error.message;
    return res.status(500).json(result);
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
