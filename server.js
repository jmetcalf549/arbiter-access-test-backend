import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { runArbiterAutomation } from "./automation.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const SHARED_SECRET = process.env.AUTOMATION_SHARED_SECRET;

function authOk(req) {
  if (!SHARED_SECRET) return true;
  const h = req.headers["authorization"] || "";
  if (h === `Bearer ${SHARED_SECRET}`) return true;
  if (req.headers["x-automation-secret"] === SHARED_SECRET) return true;
  return false;
}

// In-memory snapshot store keyed by runId so the polling client can see
// progress (especially "waiting_for_manual_captcha") while the POST is
// still in flight. Snapshots auto-expire 10 minutes after completion.
const JOBS = new Map(); // runId -> { snapshot, doneAt? }
const JOB_TTL_MS = 10 * 60 * 1000;

function setJob(runId, snapshot) {
  if (!runId) return;
  const existing = JOBS.get(runId) ?? {};
  JOBS.set(runId, { ...existing, snapshot, updatedAt: Date.now() });
}
function finishJob(runId) {
  if (!runId) return;
  const existing = JOBS.get(runId);
  if (!existing) return;
  existing.doneAt = Date.now();
  JOBS.set(runId, existing);
  setTimeout(() => JOBS.delete(runId), JOB_TTL_MS).unref?.();
}

app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

async function handleTestLogin(req, res) {
  if (!authOk(req)) return res.status(401).json({ status: "failed", error_type: "unauthorized", error_message: "Bad shared secret." });
  const {
    username, password, browserbaseApiKey, browserbaseProjectId,
    runId: clientRunId, manualCaptchaMode, captureFailureScreenshots,
  } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ status: "failed", error_type: "missing_credentials", error_message: "username and password are required." });
  }
  const runId = clientRunId || randomUUID();
  setJob(runId, { status: "starting", current_step: "queued", run_id: runId });
  try {
    const result = await runArbiterAutomation({
      runId, username, password, browserbaseApiKey, browserbaseProjectId,
      manualCaptchaMode: manualCaptchaMode === true,
      captureFailureScreenshots: captureFailureScreenshots !== false,
      onUpdate: (snap) => setJob(runId, { ...snap, run_id: runId }),
      logger: console,
    });
    setJob(runId, { ...result, run_id: runId });
    res.json({ ...result, run_id: runId });
  } catch (err) {
    console.error("[server] unhandled", err?.message);
    const out = { status: "failed", error_type: "server_error", error_message: err?.message ?? "unknown", run_id: runId };
    setJob(runId, out);
    res.status(500).json(out);
  } finally {
    finishJob(runId);
  }
}

function handleJobStatus(req, res) {
  if (!authOk(req)) return res.status(401).json({ status: "failed", error_type: "unauthorized" });
  const { runId } = req.params;
  const job = JOBS.get(runId);
  if (!job) return res.status(404).json({ status: "unknown", run_id: runId, error_type: "not_found", error_message: "No job snapshot for runId (yet, or already expired)." });
  res.json({ ...(job.snapshot || {}), run_id: runId, _done: !!job.doneAt });
}

app.post("/arbiter-test", handleTestLogin);
app.post("/api/arbiter/test-login", handleTestLogin);
app.get("/api/arbiter/jobs/:runId", handleJobStatus);
app.get("/arbiter-test/:runId", handleJobStatus);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[arbiter-automation] listening on :${PORT}`));
