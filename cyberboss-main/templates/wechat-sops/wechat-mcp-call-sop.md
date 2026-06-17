# WeChat MCP Call SOP

Use this L3 SOP when a WeChat task needs Cyberboss MCP tools from GenericAgent code execution. This is the fixed path. Do not discover CLI commands, edit queues, inspect source code, use browser screenshots, use desktop screenshots, or ask the user to switch windows unless this SOP explicitly fails and the user approves a fallback.

## Scope

Use Cyberboss MCP for:

- `cyberboss_timeline_read`, `cyberboss_timeline_write`, `cyberboss_timeline_build`, `cyberboss_timeline_screenshot`
- `cyberboss_channel_send_file`
- `cyberboss_diary_append`
- `cyberboss_reminder_create`
- whereabouts tools

Do not directly read or edit Cyberboss state JSON files. Use MCP tools.

## Preferred Fixed Python Scripts

Prefer these checked-in scripts before writing any inline Python. They live under:

```text
cyberboss-main/templates/wechat-sops/python-sops/
```

Run them from `code_run` or an equivalent Python runner. Use command-line arguments instead of editing the scripts.

Send an existing file:

```powershell
python cyberboss-main/templates/wechat-sops/python-sops/send_file.py --file "D:\path\to\file.md"
```

Timeline screenshots:

```powershell
python cyberboss-main/templates/wechat-sops/python-sops/timeline_screenshot.py --range week
python cyberboss-main/templates/wechat-sops/python-sops/timeline_screenshot.py --range day --date 2026-05-07
python cyberboss-main/templates/wechat-sops/python-sops/timeline_screenshot.py --range month --month 2026-05
```

Append diary:

```powershell
python cyberboss-main/templates/wechat-sops/python-sops/diary_append.py --text "简短日记内容"
```

Generic MCP tool call:

```powershell
python cyberboss-main/templates/wechat-sops/python-sops/mcp_tool.py --tool cyberboss_timeline_read --arguments-json '{"date":"2026-05-07"}'
```

Success rule: if a script prints `TERMINAL_SUCCESS`, stop immediately. Do not resend, re-screenshot, inspect ports, or clean up global processes.

Only write inline Python from the template below when the fixed scripts do not cover the task. If a fixed script needs modification, do not rewrite it during a WeChat turn unless the user explicitly asks; report the missing capability and use a temporary copy only after approval.

## Paths

All paths are based on `CYBERBOSS_WORKSPACE_ROOT`.

Default root:

```text
{WORKSPACE_ROOT}
```

Derived paths:

```text
<root>\cyberboss-main
<root>\cyberboss-data
<root>\cyberboss-main\.env
<root>\cyberboss-main\bin\cyberboss.js
```

Read `CYBERBOSS_ACCOUNT_ID` from `<root>\cyberboss-main\.env`. Prefer the file value over a stale process environment value.

## Fixed Python JSON-RPC Template

Use this template from `code_run` when the MCP tool is not directly exposed as a native model tool.

```python
import json
import os
import subprocess
import sys
from pathlib import Path

root = Path(os.environ.get("CYBERBOSS_WORKSPACE_ROOT") or Path.cwd())
home = root / "cyberboss-main"
env_path = home / ".env"

def read_env_file(path):
    result = {}
    if not path.exists():
        return result
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip('"').strip("'")
    return result

file_env = read_env_file(env_path)
account = file_env.get("CYBERBOSS_ACCOUNT_ID") or os.environ.get("CYBERBOSS_ACCOUNT_ID")
if not account:
    raise RuntimeError(f"CYBERBOSS_ACCOUNT_ID not found in {env_path}")

env = os.environ.copy()
env.setdefault("CYBERBOSS_WORKSPACE_ROOT", str(root))
env.setdefault("CYBERBOSS_STATE_DIR", "cyberboss-data")
env.setdefault("CYBERBOSS_HOME", "cyberboss-main")
env["CYBERBOSS_ACCOUNT_ID"] = account

proc = subprocess.Popen(
    ["node", str(home / "bin" / "cyberboss.js"), "tool-mcp-server", "--account", account],
    cwd=str(home),
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
    errors="replace",
    env=env,
    bufsize=1,
)
started_pid = proc.pid

next_id = 1

def request(method, params=None, expect_response=True):
    global next_id
    msg = {
        "jsonrpc": "2.0",
        "id": next_id,
        "method": method,
        "params": params or {},
    }
    next_id += 1
    proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
    proc.stdin.flush()
    if not expect_response:
        return None
    line = proc.stdout.readline()
    if not line:
        stderr = proc.stderr.read()
        raise RuntimeError(f"MCP process ended without response. stderr={stderr}")
    return json.loads(line)

def notify(method, params=None):
    msg = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params or {},
    }
    proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
    proc.stdin.flush()

def call_tool(name, arguments=None):
    return request("tools/call", {
        "name": name,
        "arguments": arguments or {},
    })

def tool_text(response):
    content = response.get("result", {}).get("content", [])
    if content and isinstance(content[0], dict):
        return str(content[0].get("text") or "")
    return ""

def tool_data(response):
    text = tool_text(response)
    start = text.find("{")
    if start < 0:
        return {}
    try:
        return json.loads(text[start:])
    except Exception:
        return {}

def terminal_file_sent(response):
    text = tool_text(response)
    data = tool_data(response)
    delivery = data.get("delivery") if isinstance(data.get("delivery"), dict) else data
    return (
        text.startswith("File sent:")
        or bool(delivery.get("sent") is True)
        or delivery.get("ret") == 0
    )

def output_file_from(response):
    data = tool_data(response)
    value = data.get("outputFile")
    return str(value or "")

try:
    print("initialize:", request("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "genericagent-python", "version": "1"},
    }))
    notify("notifications/initialized")

    # Optional: inspect schemas before guessing arguments.
    # print(json.dumps(request("tools/list"), ensure_ascii=False, indent=2))

    # Put task-specific tool calls here before leaving this try block.
finally:
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
    except Exception:
        pass
```

Important:

- Tool names go inside `method="tools/call"` as `params.name`.
- Never call `"method": "cyberboss_timeline_screenshot"` or `"method": "cyberboss_channel_send_file"`.
- `notifications/initialized` is a notification. Do not wait for a response to it.
- Prefer `cyberboss-main\.env` account over inherited process env. If they differ, use `.env` and mention the mismatch only when debugging account issues.
- Determine delivery success from `terminal_file_sent(response)` or parsed `delivery` fields, not from `json.dumps(response)` string matching. JSON-RPC nests tool output as text, so string checks for `"sent": true` can be escaped and wrong.
- `tool-mcp-server` is a long-lived stdio server. It will not exit by itself after one tool call. Always leave the `try` block and run the `finally` cleanup after the task is complete.
- Only terminate the `proc` object started by this script (`started_pid`). Never run `taskkill`, never kill all `node.exe`, and never clean up unrelated Node processes.
- If `code_run` times out, treat it as a script lifecycle/cleanup failure first, not proof that day/month/week screenshot is broken. On retry, use this exact template and shorter task-specific calls.
- If a hand-written MCP script hits `ncrypto::CSPRNG` or no output, retry once using this exact template before diagnosing Node, token, account, or Cyberboss code.

## Timeline Screenshot Template

Prefer `python-sops/timeline_screenshot.py` for normal day/week/month screenshots. Use this inline template only as a fallback.

For timeline screenshots, follow this order exactly:

1. `cyberboss_timeline_build`
2. `tools/list` if you need the exact schema
3. `cyberboss_timeline_screenshot`
4. If screenshot delivery is not terminal success but `outputFile` exists, call `cyberboss_channel_send_file` once with that same file
5. Stop on terminal success

Paste this body into the template's `# Put task-specific tool calls here` section:

```python
from datetime import datetime
from pathlib import Path

today = datetime.now().strftime("%Y-%m-%d")
month = datetime.now().strftime("%Y-%m")
shot_dir = root / "cyberboss-data" / "timeline" / "screenshots"
shot_dir.mkdir(parents=True, exist_ok=True)

print("build:", json.dumps(call_tool("cyberboss_timeline_build", {
    "locale": "zh-CN",
}), ensure_ascii=False, indent=2))

# Use one of these screenshot argument sets.
week_args = {
    "range": "week",
    "locale": "zh-CN",
    "selector": "main",
    "outputFile": str(shot_dir / f"weekly-{today}.png"),
}

month_args = {
    "range": "month",
    "month": month,
    "locale": "zh-CN",
    "selector": "main",
    "outputFile": str(shot_dir / f"monthly-{month}.png"),
}

day_args = {
    "range": "day",
    "date": today,
    "locale": "zh-CN",
    "selector": "main",
    "outputFile": str(shot_dir / f"daily-{today}.png"),
}

shot = call_tool("cyberboss_timeline_screenshot", week_args)
print("screenshot:", json.dumps(shot, ensure_ascii=False, indent=2))

if terminal_file_sent(shot):
    print("TERMINAL_SUCCESS")
else:
    # Use the returned outputFile first, then the exact outputFile passed to the screenshot call.
    # Do not glob random screenshot directories.
    output_file = output_file_from(shot) or week_args.get("outputFile") or month_args.get("outputFile") or day_args.get("outputFile")
    if output_file and Path(output_file).exists():
        sent = call_tool("cyberboss_channel_send_file", {"filePath": output_file})
        print("send_file:", json.dumps(sent, ensure_ascii=False, indent=2))
        if terminal_file_sent(sent):
            print("TERMINAL_SUCCESS")
```

When possible, pass an explicit `outputFile` so fallback send uses the same captured image. For month screenshots, always pass `month="YYYY-MM"` and explicit `outputFile`.

## Send Existing File Template

Prefer `python-sops/send_file.py` for existing files. Use this inline template only as a fallback.

```python
file_path = r"{WORKSPACE_ROOT}\cyberboss-data\timeline\screenshots\example.png"
sent = call_tool("cyberboss_channel_send_file", {"filePath": file_path})
print(json.dumps(sent, ensure_ascii=False, indent=2))
if terminal_file_sent(sent):
    print("TERMINAL_SUCCESS")
```

If `terminal_file_sent(sent)` is true, stop. Do not ask the user whether it arrived, and do not resend.

## Record Tool Examples

Prefer `python-sops/diary_append.py` for diary append and `python-sops/mcp_tool.py` for timeline read/write or other record tools when arguments are simple.

Diary:

```python
result = call_tool("cyberboss_diary_append", {
    "text": "简短记录今天真正值得延续的状态、决定或关系上下文。"
})
print(json.dumps(result, ensure_ascii=False, indent=2))
```

Timeline read:

```python
result = call_tool("cyberboss_timeline_read", {
    "date": "2026-05-07"
})
print(json.dumps(result, ensure_ascii=False, indent=2))
```

Timeline write:

Use Beijing local wall-clock time with an explicit `+08:00` offset for every `startAt` and `endAt`. Do not manually convert to UTC and do not pass `Z` timestamps.

```python
result = call_tool("cyberboss_timeline_write", {
    "date": "2026-05-07",
    "events": [{
        "startAt": "2026-05-07T12:00:00+08:00",
        "endAt": "2026-05-07T12:30:00+08:00",
        "title": "吃午饭",
        "categoryId": "life",
        "subcategoryId": "life.meal",
        "note": "只记录事实和必要上下文，不写成聊天转录。"
    }]
})
print(json.dumps(result, ensure_ascii=False, indent=2))
```

Before writing a timeline day, read that day first unless the system maintenance prompt explicitly says this is a simple new event and gives enough schema context.

## Failure Discipline

- `ret=-2` is only a rejected WeChat send stage. Do not claim token/login failure unless the failing message explicitly says missing account, account mismatch, missing context token, or auth/config failure.
- If screenshot is captured but final send fails, report the exact stage and output path briefly.
- Do not debug Node, source code, queues, browser tabs, or desktop windows after one successful `File sent`.
- Do not inspect or kill global `node.exe` processes. If cleanup is needed, only stop the PID in `started_pid` from this script.
- Do not use `tasklist`/`taskkill` as normal recovery for MCP timeout. Timeout usually means the Python script did not close/terminate its own stdio MCP subprocess.
- Stop after three failed MCP attempts and ask the user for direction with the concrete failing stage.
