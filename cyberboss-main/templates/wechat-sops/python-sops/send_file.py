import argparse
import sys
from pathlib import Path

from mcp_client import CyberbossMcpClient, print_json, resolve_workspace_root, terminal_file_sent


def parse_args():
    parser = argparse.ArgumentParser(description="Send an existing file to the current Cyberboss WeChat channel.")
    parser.add_argument("--file", required=True, help="File path to send. Relative paths are resolved from workspace root.")
    parser.add_argument("--root", default=None, help="CYBERBOSS_WORKSPACE_ROOT override.")
    parser.add_argument("--account", default=None, help="CYBERBOSS_ACCOUNT_ID override. Defaults to cyberboss-main/.env.")
    return parser.parse_args()


def main():
    args = parse_args()
    root = resolve_workspace_root(args.root)
    file_path = Path(args.file)
    if not file_path.is_absolute():
        file_path = (root / file_path).resolve()
    if not file_path.is_file():
        raise FileNotFoundError(f"file not found: {file_path}")

    print(f"FILE: {file_path}")
    print(f"SIZE_BYTES: {file_path.stat().st_size}")

    with CyberbossMcpClient(root=str(root), account=args.account) as client:
        sent = client.call_tool("cyberboss_channel_send_file", {"filePath": str(file_path)})
        print_json("send_file", sent)
        if terminal_file_sent(sent):
            print("TERMINAL_SUCCESS")
            return 0
        print("TERMINAL_FAILURE")
        return 2


if __name__ == "__main__":
    sys.exit(main())
