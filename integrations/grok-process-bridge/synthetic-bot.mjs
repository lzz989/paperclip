import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

const statePath = process.argv[2];
const result = process.argv[3] ?? "";
const mode = process.argv[4] ?? "once";
const delayMs = Number(process.argv[5] ?? "0");
if (!statePath || !Number.isFinite(delayMs) || delayMs < 0) process.exit(2);

const state = JSON.parse(readFileSync(statePath, "utf8"));
const url = new URL(state.callbackUrl);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") process.exit(2);

function post(body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${state.token}`,
        "content-type": "application/json",
        "content-length": String(payload.length),
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const binding = {
  companyId: state.companyId,
  agentId: state.agentId,
  runId: state.runId,
  issueId: mode === "mismatch" ? "00000000-0000-4000-8000-000000000000" : state.issueId,
  result,
};

await new Promise((resolve) => setTimeout(resolve, delayMs));
const sends = mode === "duplicate" ? 2 : 1;
for (let index = 0; index < sends; index += 1) {
  const status = await post(binding);
  process.stdout.write(`callback_status=${status}\n`);
}
