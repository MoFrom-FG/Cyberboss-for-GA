import argparse
import json
import sys
from pathlib import Path

from mcp_client import CyberbossMcpClient, print_json, terminal_file_sent


def parse_args():
    parser = argparse.ArgumentParser(description="Call a Cyberboss MCP tool with JSON arguments.")
    parser.add_argument("--tool", required=True, help="MCP tool name, e.g. cyberboss_diary_append.")
    parser.add_argument("--arguments-json", default="{}", help="JSON object string for tool arguments.")
    parser.add_argument("--arguments-file", default=None, help="Path to a JSON file containing tool arguments.")
    parser.add_argument("--root", default=None, help="CYBERBOSS_WORKSPACE_ROOT override.")
    parser.add_argument("--account", default=None, help="CYBERBOSS_ACCOUNT_ID override. Defaults to cyberboss-main/.env.")
    return parser.parse_args()


def load_arguments(args):
    if args.arguments_file:
        text = Path(args.arguments_file).read_text(encoding="utf-8")
    else:
        text = args.arguments_json
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("tool arguments must be a JSON object")
    return value


def main():
    args = parse_args()
    tool_args = load_arguments(args)
    with CyberbossMcpClient(root=args.root, account=args.account) as client:
        result = client.call_tool(args.tool, tool_args)
        print_json("result", result)
        if terminal_file_sent(result):
            print("TERMINAL_SUCCESS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
