import "dotenv/config";
import express from "express";
import cors from "cors";
import { runArbiterAutomation } from "./automation.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const SHARED_SECRET = process.env.AUTOMATION_SHARED_SECRET;

function authOk(req) {
  if (!SHARED_SECRET) return true; // allow if not configured (dev)
  const h = req.headers["authorization"] || "";
  if (h === `Bearer ${SHARED_SECRET}`) return true;
  if (req.headers["x-automation-secret"] === SHARED_SECRET) return true;
  return false;
}

app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

async function handleTestLogin(req, res) {
  if (!authOk(req)) return res.status(401).json({ status: "failed", error_type: "unauthorized", error_message: "Bad shared secret." });
  const { username, password, browserbaseApiKey, browserbaseProjectId, runId } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ status: "failed", error_type: "missing_credentials", error_message: "username and password are required." });
  }
  try {
    const result = await runArbiterAutomation({
      runId, username, password, browserbaseApiKey, browserbaseProjectId,
      logger: console,
    });
    res.json(result);
  } catch (err) {
    console.error("[server] unhandled", err?.message);
    res.status(500).json({ status: "failed", error_type: "server_error", error_message: err?.message ?? "unknown" });
  }
}

// Both the original and the path the frontend uses.
app.post("/arbiter-test", handleTestLogin);
app.post("/api/arbiter/test-login", handleTestLogin);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[arbiter-automation] listening on :${PORT}`));
