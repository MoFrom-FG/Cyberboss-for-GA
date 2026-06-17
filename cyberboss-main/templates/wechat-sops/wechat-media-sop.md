# WeChat Media SOP

Use this SOP only for timeline screenshots, sending files, media delivery, account/context-token diagnosis, and `ret=-2` handling. Do not use it for normal diary or timeline writing.

If Cyberboss MCP tools are not directly exposed as native tools, first read `cyberboss-main/templates/wechat-sops/wechat-mcp-call-sop.md` and use the fixed scripts under `cyberboss-main/templates/wechat-sops/python-sops/` before writing inline Python. Do not look for Cyberboss CLI screenshot commands, do not write screenshot queues, do not read source code to discover handlers, and do not use browser/desktop screenshot fallbacks.

Preferred scripts:

- Existing files: `python cyberboss-main/templates/wechat-sops/python-sops/send_file.py --file "<absolute-or-workspace-relative-path>"`
- Timeline screenshots: `python cyberboss-main/templates/wechat-sops/python-sops/timeline_screenshot.py --range week|day|month`

## Core Flow

- For timeline screenshots, use `cyberboss_timeline_build` first, then `cyberboss_timeline_screenshot`.
- If the result text starts with `File sent`, or parsed `delivery.sent=true`, or parsed `delivery.ret=0`, the task is complete. Stop immediately.
- If a screenshot was captured but built-in delivery failed, send the returned `data.outputFile` exactly once with `cyberboss_channel_send_file`.
- If `cyberboss_channel_send_file` returns `File sent`, the task is complete. Stop immediately.
- If a fixed Python script prints `TERMINAL_SUCCESS`, the task is complete. Stop immediately.
- Do not resend, re-screenshot, glob random directories, ask whether it arrived, or reinterpret an earlier failure after terminal success.
- Do not decide success by searching `json.dumps(response)` for `"sent": true`; JSON-RPC nests tool output as text, so quotes may be escaped. Use the helper functions in `wechat-mcp-call-sop.md` or parse the returned `delivery` object.
- If `code_run` times out while using the Python JSON-RPC bridge, suspect MCP subprocess lifecycle cleanup first. Do not conclude that day/month/week screenshot is broken.
- Never use `taskkill`, never kill all `node.exe`, and never inspect process lists as normal media recovery. The only allowed cleanup is terminating the `proc` object started by the current Python script, as shown in `wechat-mcp-call-sop.md`.

## Screenshot Parameters

- Week view: use `range="week"` and the requested/current week.
- Month view: use `range="month"`, `month="YYYY-MM"`, and an explicit `outputFile` under `cyberboss-data/timeline/screenshots/`.
- Prefer controlled selectors: `main`, `timeline`, `analytics`, `events`.
- Build or refresh the timeline site before screenshot work when needed.

## ret=-2 Discipline

`ret=-2` only means the current WeChat API stage was rejected. It is not enough evidence to claim login/token/auth failure.

Only mention login/token/auth when the failing stage is authentication/config related, such as missing account file, account mismatch, missing context token key, or explicit config/auth failure.

For final `sendMessage ret=-2`, report the exact stage: screenshot or file was generated, but WeChat final sendMessage rejected it with unknown cause. Do not ask the user to rerun login from that fact alone.

For timeouts, report the stage as Python/MCP bridge lifecycle timeout unless the tool returned a concrete screenshot error. Retry once with the fixed template; then stop and ask the user.

## Account and User IDs

- Use the current `CYBERBOSS_ACCOUNT_ID` from `cyberboss-main/.env`, not stale logs.
- WeChat `userId` must use `...@im.wechat`. Do not pass file-safe ids like `..._im.wechat`.
- Context tokens live under `cyberboss-data/accounts/<accountId>.context-tokens.json`.

## MCP JSON-RPC

MCP tool names go inside `tools/call` as `params.name`. Never use a tool name as the JSON-RPC `method`.

Correct:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cyberboss_channel_send_file","arguments":{"filePath":"..."}}}
```

For complete runnable Python examples, use `cyberboss-main/templates/wechat-sops/wechat-mcp-call-sop.md`.
