import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt.ts";
import { execute } from "../../server/src/adapters/process/execute.ts";
import { startRunnerApiTestServer } from "../../server/src/__tests__/helpers/runner-api-server.ts";

process.env.PAPERCLIP_AGENT_JWT_SECRET ||= crypto.randomUUID();

const bridgePath = new URL("./bridge.mjs", import.meta.url);
const botPath = new URL("./synthetic-bot.mjs", import.meta.url);
const webhookToken = `whk_${crypto.randomUUID().replaceAll("-", "")}`;

function outcome(result: { exitCode: number | null; signal: string | null; timedOut: boolean; errorMessage?: string | null; resultJson?: { status?: string } | null }) {
  if (result.timedOut) return "timed_out";
  if (result.resultJson?.status === "cancelled") return "cancelled";
  if ((result.exitCode ?? 0) === 0 && !result.errorMessage && !result.signal) return "succeeded";
  return "failed";
}

function assertClean(text: string, secrets: string[], label: string) {
  for (const secret of secrets) {
    if (secret && text.includes(secret)) assert.fail(`${label} contains a credential`);
  }
}

async function waitFor(path: string) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.fail("callback file was not created");
}

describe("native process bridge", { concurrency: 1 }, () => {
  it("reads timeout and run-jwt rules from this commit", async () => {
    const adapter = await readFile(new URL("../../server/src/adapters/process/execute.ts", import.meta.url), "utf8");
    const completion = await readFile(new URL("../../server/src/services/heartbeat/run-completion.ts", import.meta.url), "utf8");
    assert.match(adapter, /const timeoutSec = asNumber\(config\.timeoutSec, 0\)/);
    assert.match(adapter, /if \(authToken\) env\.PAPERCLIP_API_KEY = authToken/);
    assert.match(adapter, /if \(isForbiddenConfigEnvKey\(k\)\) continue/);
    assert.match(completion, /!adapterResult\.signal/);
    assert.match(completion, /adapterResult\.timedOut/);
  });

  it("keeps the harness run jwt when config supplies another key", async () => {
    const jwt = createLocalAgentJwt(
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "process",
      "11111111-1111-4111-8111-111111111111",
      "user-1",
    );
    assert.ok(jwt);
    let logged = "";
    const result = await execute({
      runId: "11111111-1111-4111-8111-111111111111",
      agent: { id: "22222222-2222-4222-8222-222222222222", companyId: "33333333-3333-4333-8333-333333333333", name: "Bridge", adapterType: "process", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.PAPERCLIP_API_KEY === process.env.EXPECTED_RUN_JWT ? 'run-jwt' : 'other')"],
        cwd: process.cwd(),
        env: { PAPERCLIP_API_KEY: "attacker-key", EXPECTED_RUN_JWT: jwt },
      },
      context: {},
      authToken: jwt,
      onLog: async (_stream, chunk) => { logged += chunk; },
    });
    assert.equal(result.resultJson?.stdout, "run-jwt");
    assert.equal(outcome(result), "succeeded");
    assert.equal(logged.includes(jwt), false);
  });

  it("holds a running run past 30s, writes once, and rejects the other outcomes", { timeout: 180_000 }, async () => {
    const server = await startRunnerApiTestServer();
    const grokBodies: string[] = [];
    let grokStatus = 200;
    const grok = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        grokBodies.push(Buffer.concat(chunks).toString("utf8"));
        const authorized = req.headers.authorization === `Bearer ${webhookToken}`;
        res.writeHead(authorized ? grokStatus : 401).end("{}");
      });
    });
    await new Promise<void>((resolve) => grok.listen(0, "127.0.0.1", resolve));
    const grokAddress = grok.address();
    if (!grokAddress || typeof grokAddress === "string") throw new Error("grok listener missing");
    process.env.PAPERCLIP_API_URL = server.apiUrl;
    const secrets = [webhookToken];
    try {
      const fixture = await server.fixture({ reset: true, connectionScenario: "fresh" });
      const runId = fixture.runId;
      const issueId = fixture.issueId;
      await server.db.update(agents).set({ adapterType: "process", adapterConfig: {} }).where(eq(agents.id, fixture.agentId));
      await server.db.update(heartbeatRuns).set({
        runtimeMode: "legacy",
        status: "running",
        controllerBootId: crypto.randomUUID(),
        controllerLeaseExpiresAt: new Date(Date.now() + 180_000),
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      }).where(eq(heartbeatRuns.id, runId));
      await server.db.update(issues).set({
        status: "in_progress",
        assigneeAgentId: fixture.agentId,
        checkoutRunId: runId,
        executionRunId: runId,
      }).where(eq(issues.id, issueId));
      const jwt = createLocalAgentJwt(fixture.agentId, fixture.companyId, "process", runId, fixture.responsibleUserId);
      assert.ok(jwt);
      secrets.push(jwt);

      const otherRunId = crypto.randomUUID();
      await server.db.insert(heartbeatRuns).values({
        id: otherRunId,
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        status: "running",
        runtimeMode: "legacy",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      });
      const otherJwt = createLocalAgentJwt(fixture.agentId, fixture.companyId, "process", otherRunId, fixture.responsibleUserId);
      assert.ok(otherJwt);
      secrets.push(otherJwt);
      const conflict = await fetch(`${server.apiUrl}/api/issues/${issueId}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${otherJwt}`,
          "x-paperclip-run-id": otherRunId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "done", comment: "stolen" }),
      });
      assert.equal(conflict.status, 409);
      assert.equal((await server.db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]?.status, "in_progress");

      const runCase = async (input: {
        dir: string;
        timeoutSec: number;
        graceSec?: number;
        bot?: [string, string, string];
        kill?: boolean;
        holdMs?: number;
      }) => {
        const logs: string[] = [];
        const stateFile = join(input.dir, "callback.json");
        let pid = 0;
        const pending = execute({
          runId,
          agent: { id: fixture.agentId, companyId: fixture.companyId, name: "Bridge", adapterType: "process", adapterConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: process.execPath,
            args: [bridgePath.pathname],
            cwd: input.dir,
            timeoutSec: input.timeoutSec,
            graceSec: input.graceSec ?? 1,
            env: {
              GROK_WEBHOOK_URL: `http://127.0.0.1:${grokAddress.port}/wake`,
              GROK_WEBHOOK_TOKEN: webhookToken,
              BRIDGE_STATE_DIR: input.dir,
              PAPERCLIP_API_KEY: "attacker-key",
            },
          },
          context: {},
          authToken: jwt,
          onLog: async (_stream, chunk) => { logs.push(chunk); },
          onSpawn: async (meta) => { pid = meta.pid; },
        });
        if (input.kill) {
          const started = Date.now();
          while (!pid && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 20));
          assert.ok(pid > 0);
          process.kill(pid, "SIGKILL");
        }
        if (input.holdMs) {
          await waitFor(stateFile);
          assert.equal((await server.db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status, "running");
          await new Promise((resolve) => setTimeout(resolve, input.holdMs));
          assert.equal((await server.db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status, "running");
        }
        if (input.bot) {
          if (!input.holdMs) await waitFor(stateFile);
          const child = spawn(process.execPath, [botPath.pathname, stateFile, ...input.bot], { stdio: ["ignore", "pipe", "pipe"] });
          let botOut = "";
          child.stdout.on("data", (chunk) => { botOut += String(chunk); });
          const botCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
          assert.equal(botCode, 0);
          assert.match(botOut, /callback_status=/);
          assertClean(botOut, secrets, "synthetic bot output");
        }
        const result = await pending;
        const output = `${result.resultJson?.stdout ?? ""}\n${result.resultJson?.stderr ?? ""}`;
        let callbackToken = "";
        try {
          callbackToken = (JSON.parse(await readFile(stateFile, "utf8")) as { token?: string }).token ?? "";
        } catch {
          callbackToken = "";
        }
        const sensitive = callbackToken ? [...secrets, callbackToken] : secrets;
        assertClean(logs.join(""), sensitive, "adapter log");
        assertClean(output, sensitive, "process output");
        return { result, output, logs: logs.join("") };
      };

      grokStatus = 500;
      const rejected = await runCase({ dir: await mkdtemp(join(tmpdir(), "grok-bridge-")), timeoutSec: 30 });
      assert.equal(outcome(rejected.result), "failed");
      assert.match(`${rejected.output}\n${rejected.logs}`, /webhook_rejected:500/);
      grokStatus = 200;

      const timed = await runCase({ dir: await mkdtemp(join(tmpdir(), "grok-bridge-")), timeoutSec: 2, graceSec: 1 });
      assert.equal(outcome(timed.result), "timed_out");
      assert.equal((await server.db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]?.status, "in_progress");

      const killed = await runCase({ dir: await mkdtemp(join(tmpdir(), "grok-bridge-")), timeoutSec: 30, kill: true });
      assert.equal(outcome(killed.result), "failed");
      assert.equal(killed.result.signal, "SIGKILL");

      const mismatched = await runCase({
        dir: await mkdtemp(join(tmpdir(), "grok-bridge-")),
        timeoutSec: 8,
        bot: ["unused", "mismatch", "0"],
      });
      assert.notEqual(outcome(mismatched.result), "succeeded");
      assert.equal((await server.db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).length, 0);

      const successDir = await mkdtemp(join(tmpdir(), "grok-bridge-"));
      const succeeded = await runCase({
        dir: successDir,
        timeoutSec: 90,
        holdMs: 31_000,
        bot: ["synthetic result past thirty seconds", "duplicate", "0"],
      });
      assert.equal(outcome(succeeded.result), "succeeded");
      assert.equal((await server.db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status, "running");
      assert.equal((await server.db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]?.status, "done");
      const comments = await server.db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId));
      assert.deepEqual(comments.map((row) => row.body), ["synthetic result past thirty seconds"]);
      const wake = grokBodies.map((body) => JSON.parse(body) as { callbackUrl?: string; token?: string });
      assert.equal(wake.some((body) => body.token), false);
      assert.equal(wake.some((body) => body.callbackUrl?.startsWith("http://127.0.0.1:")), true);
      const stateStat = await stat(join(successDir, "callback.json"));
      assert.equal(stateStat.mode & 0o077, 0);
    } finally {
      grok.close();
      await server.close();
    }
  });
});
