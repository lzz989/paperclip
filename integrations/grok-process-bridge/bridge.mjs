import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

const REQUIRED = [
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "GROK_WEBHOOK_URL",
  "GROK_WEBHOOK_TOKEN",
  "BRIDGE_STATE_DIR",
];

function logEvent(code) {
  process.stderr.write(`bridge_event=${code}\n`);
}

function fail(code) {
  logEvent(code);
  process.exit(1);
}

function requiredEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) fail("missing_env");
}

function loopbackUrl(value, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(code);
  }
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    fail(code);
  }
  return url;
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function paperclip(path, options = {}) {
  const response = await fetch(new URL(path, process.env.PAPERCLIP_API_URL), {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`,
      "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body,
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function bindIssue() {
  const self = await paperclip("/api/agents/me");
  if (self.status !== 200) fail(`self_rejected:${self.status}`);
  const agent = JSON.parse(self.text);
  if (agent.id !== process.env.PAPERCLIP_AGENT_ID || agent.companyId !== process.env.PAPERCLIP_COMPANY_ID) {
    fail("self_mismatch");
  }
  const inbox = await paperclip("/api/agents/me/inbox-lite");
  if (inbox.status !== 200) fail(`inbox_rejected:${inbox.status}`);
  const rows = JSON.parse(inbox.text);
  const matches = Array.isArray(rows)
    ? rows.filter((row) => row?.activeRun?.id === process.env.PAPERCLIP_RUN_ID && row.activeRun.status === "running")
    : [];
  if (matches.length !== 1) fail("issue_unbound");
  const issueId = matches[0].id;
  if (process.env.PAPERCLIP_TASK_ID && process.env.PAPERCLIP_TASK_ID !== issueId) fail("task_mismatch");
  return issueId;
}

function postJson(url, headers, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "content-length": String(payload.length) },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

requiredEnv();
const apiUrl = loopbackUrl(process.env.PAPERCLIP_API_URL, "api_not_loopback");
const webhookUrl = loopbackUrl(process.env.GROK_WEBHOOK_URL, "webhook_not_loopback");
if (!apiUrl || !webhookUrl) process.exit(1);

const issueId = await bindIssue();
const callbackToken = randomBytes(32).toString("hex");
const binding = {
  companyId: process.env.PAPERCLIP_COMPANY_ID,
  agentId: process.env.PAPERCLIP_AGENT_ID,
  runId: process.env.PAPERCLIP_RUN_ID,
  issueId,
};
let applied = false;
let chain = Promise.resolve();
let idleTimer;

function exclusive(work) {
  const run = chain.then(work, work);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/result") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 16_384) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    void exclusive(async () => {
      const header = String(req.headers.authorization ?? "");
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!presented || !sameSecret(presented, callbackToken)) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "callback_unauthorized" }));
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (body.companyId !== binding.companyId || body.agentId !== binding.agentId
        || body.runId !== binding.runId || body.issueId !== binding.issueId) {
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "callback_binding_mismatch" }));
        return;
      }
      if (typeof body.result !== "string" || body.result.trim().length === 0 || body.result.length > 4000) {
        res.writeHead(422).end();
        return;
      }
      if (applied) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ applied: false, duplicate: true }));
        armIdleExit();
        return;
      }
      const written = await paperclip(`/api/issues/${binding.issueId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done", comment: body.result }),
      });
      logEvent(`write_status:${written.status}`);
      if (written.status < 200 || written.status >= 300) {
        res.writeHead(written.status, { "content-type": "application/json" }).end(JSON.stringify({ applied: false }));
        setImmediate(() => fail("write_rejected"));
        return;
      }
      applied = true;
      await writeFile(join(process.env.BRIDGE_STATE_DIR, "applied.json"), JSON.stringify({
        companyId: binding.companyId,
        agentId: binding.agentId,
        runId: binding.runId,
        issueId: binding.issueId,
      }), { mode: 0o600 });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ applied: true, duplicate: false }));
      armIdleExit();
    }).catch(() => fail("callback_failed"));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") fail("callback_listen_failed");
const callbackUrl = `http://127.0.0.1:${address.port}/result`;
await mkdir(process.env.BRIDGE_STATE_DIR, { recursive: true, mode: 0o700 });
await writeFile(join(process.env.BRIDGE_STATE_DIR, "callback.json"), JSON.stringify({
  ...binding,
  callbackUrl,
  token: callbackToken,
}), { mode: 0o600 });
logEvent("callback_ready");

function armIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => server.close(), 400);
}

let webhookStatus = 0;
try {
  webhookStatus = await postJson(webhookUrl, {
    authorization: `Bearer ${process.env.GROK_WEBHOOK_TOKEN}`,
  }, {
    kind: "paperclip.process_bridge.wake",
    ...binding,
    callbackUrl,
  });
} catch {
  fail("webhook_unreachable");
}
if (webhookStatus < 200 || webhookStatus >= 300) fail(`webhook_rejected:${webhookStatus}`);
logEvent("webhook_accepted");

await new Promise((resolve) => server.on("close", resolve));
if (!applied) fail("exited_without_result");
logEvent("exit_ok");
process.exit(0);
