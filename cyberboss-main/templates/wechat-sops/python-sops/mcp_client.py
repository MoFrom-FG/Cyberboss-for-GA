import json
import os
import subprocess
from pathlib import Path


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


def resolve_workspace_root(root=None):
    if root:
        return Path(root).expanduser().resolve()
    env_root = os.environ.get("CYBERBOSS_WORKSPACE_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    return Path.cwd().resolve()


def resolve_based_path(root, value, default_name):
    raw = value or default_name
    path = Path(raw)
    if path.is_absolute():
        return path
    return root / path


class CyberbossMcpClient:
    def __init__(self, root=None, account=None):
        self.root = resolve_workspace_root(root)
        self.home = self.root / "cyberboss-main"
        self.env_path = self.home / ".env"
        self.file_env = read_env_file(self.env_path)
        self.account = account or self.file_env.get("CYBERBOSS_ACCOUNT_ID") or os.environ.get("CYBERBOSS_ACCOUNT_ID")
        if not self.account:
            raise RuntimeError(f"CYBERBOSS_ACCOUNT_ID not found in {self.env_path}")
        self.proc = None
        self.started_pid = None
        self.next_id = 1

    def __enter__(self):
        env = os.environ.copy()
        env["CYBERBOSS_WORKSPACE_ROOT"] = str(self.root)
        env["CYBERBOSS_STATE_DIR"] = self.file_env.get("CYBERBOSS_STATE_DIR") or env.get("CYBERBOSS_STATE_DIR") or "cyberboss-data"
        env["CYBERBOSS_HOME"] = self.file_env.get("CYBERBOSS_HOME") or env.get("CYBERBOSS_HOME") or "cyberboss-main"
        env["CYBERBOSS_ACCOUNT_ID"] = self.account

        script = self.home / "bin" / "cyberboss.js"
        self.proc = subprocess.Popen(
            ["node", str(script), "tool-mcp-server", "--account", self.account],
            cwd=str(self.home),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            bufsize=1,
        )
        self.started_pid = self.proc.pid
        self.initialize()
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if self.proc and self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
        except Exception:
            pass
        return False

    def request(self, method, params=None):
        if not self.proc or not self.proc.stdin or not self.proc.stdout:
            raise RuntimeError("MCP process is not running")
        msg = {
            "jsonrpc": "2.0",
            "id": self.next_id,
            "method": method,
            "params": params or {},
        }
        self.next_id += 1
        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            stderr = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"MCP process ended without response. stderr={stderr}")
        return json.loads(line)

    def notify(self, method, params=None):
        if not self.proc or not self.proc.stdin:
            raise RuntimeError("MCP process is not running")
        msg = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        }
        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def initialize(self):
        response = self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "wechat-python-sop", "version": "1"},
        })
        self.notify("notifications/initialized")
        return response

    def call_tool(self, name, arguments=None):
        return self.request("tools/call", {
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


def delivery_from(response):
    data = tool_data(response)
    delivery = data.get("delivery") if isinstance(data.get("delivery"), dict) else data
    return delivery if isinstance(delivery, dict) else {}


def terminal_file_sent(response):
    text = tool_text(response)
    delivery = delivery_from(response)
    return (
        text.startswith("File sent:")
        or bool(delivery.get("sent") is True)
        or delivery.get("ret") == 0
    )


def output_file_from(response):
    data = tool_data(response)
    value = data.get("outputFile")
    return str(value or "")


def print_json(label, value):
    print(f"{label}:")
    print(json.dumps(value, ensure_ascii=False, indent=2))
