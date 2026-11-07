# Grok process bridge（候选，未接入）

这个目录不是 Paperclip 镜像的一部分，也不修改登录、Owner、SSO 或核心源码。官方 `process` adapter 在子进程退出前不会结束 run。`timeoutSec` 按秒配置，可以大于 30。运行身份只来自 adapter 注入的 run JWT，配置里的 `PAPERCLIP_API_KEY` 会被丢弃。

真实 Grok routine 没有已核验的结果查询 API。这里不发明一个。结果只通过同机 `127.0.0.1` 回调进入桥接进程。真实 Bot 能否经 Hermes 执行该回调，尚未验证。云端没有连接任何实例。

## 原生进程会注入的环境

- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_API_URL`
- `PAPERCLIP_RUN_ID`
- `PAPERCLIP_API_KEY`：仅当实例有 `PAPERCLIP_AGENT_JWT_SECRET` 或 `BETTER_AUTH_SECRET` 时，由 heartbeat 铸造的短期 run JWT

`process` adapter 不注入 `PAPERCLIP_TASK_ID`。桥接用 JWT 调用 `GET /api/agents/me` 和 `GET /api/agents/me/inbox-lite`，只接受 `activeRun.id` 等于 `PAPERCLIP_RUN_ID` 且状态为 `running` 的唯一任务。

## 以后由运维挂载时的精确要求

不要把本目录打进现有镜像构建。在 Paperclip 同一台主机上放置 `bridge.mjs`，并让 agent 使用：

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "node",
    "args": ["/opt/paperclip/grok-process-bridge/bridge.mjs"],
    "cwd": "/opt/paperclip/grok-process-bridge",
    "timeoutSec": 3600,
    "graceSec": 15,
    "env": {
      "GROK_WEBHOOK_URL": "http://127.0.0.1:9/wake",
      "GROK_WEBHOOK_TOKEN": "replace-with-a-local-webhook-token",
      "BRIDGE_STATE_DIR": "/var/lib/paperclip/grok-bridge"
    }
  }
}
```

`GROK_WEBHOOK_URL` 必须是 `http://127.0.0.1` 或 `http://localhost`。`BRIDGE_STATE_DIR` 必须是 `0700`。回调凭据写在该目录的 `callback.json`，模式 `0600`。进程日志只写事件码，不写 JWT、webhook token 或回调 token。

实例必须已经能给 process adapter 签 run JWT。Heartbeat 执行器在调用 adapter 前把 run 标为 `running`，并持有 legacy controller 租约。子进程活着时，这个租约让 run 保持 `running`。

同机 Hermes 在拿到模型结果后可以执行下面的命令。这只是候选命令，真实 Bot 没有跑过：

```sh
state=/var/lib/paperclip/grok-bridge/callback.json
token=$(jq -r .token "$state")
url=$(jq -r .callbackUrl "$state")
jq -c --arg result "$RESULT" '{companyId,agentId,runId,issueId,result:$result}' "$state" \
  | curl --fail-with-body -sS -X POST "$url" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      --data-binary @-
```

不要把 `$token` 打到日志。回调只接受文件里绑定的 company、agent、run、issue。重复回调不会再次 PATCH。写接口返回 409 时，桥接以退出码 1 结束，adapter 不把这次 run 当成成功。

## 测试

在仓库根目录、依赖已安装时：

```sh
node --import tsx --test --test-concurrency=1 integrations/grok-process-bridge/bridge.test.ts
```

测试使用该提交的 `process` adapter、`createLocalAgentJwt` 和 `createApp` 路由。Grok webhook 与结果回调由本地替身完成。
