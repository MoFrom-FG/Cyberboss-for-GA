import argparse
import sys

from mcp_client import CyberbossMcpClient, print_json


def parse_args():
    parser = argparse.ArgumentParser(description="Append one concise Cyberboss diary entry through MCP.")
    parser.add_argument("--text", required=True, help="Diary text to append.")
    parser.add_argument("--root", default=None, help="CYBERBOSS_WORKSPACE_ROOT override.")
    parser.add_argument("--account", default=None, help="CYBERBOSS_ACCOUNT_ID override. Defaults to cyberboss-main/.env.")
    return parser.parse_args()


def main():
    args = parse_args()
    with CyberbossMcpClient(root=args.root, account=args.account) as client:
        result = client.call_tool("cyberboss_diary_append", {"text": args.text})
        print_json("diary_append", result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
