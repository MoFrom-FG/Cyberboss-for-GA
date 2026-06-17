import argparse
import sys
from datetime import datetime
from pathlib import Path

from mcp_client import (
    CyberbossMcpClient,
    output_file_from,
    print_json,
    terminal_file_sent,
)


def parse_args():
    parser = argparse.ArgumentParser(description="Build, capture, and send a Cyberboss timeline screenshot.")
    parser.add_argument("--range", choices=["day", "week", "month"], default="week")
    parser.add_argument("--date", default=None, help="YYYY-MM-DD for day screenshots. Defaults to today.")
    parser.add_argument("--month", default=None, help="YYYY-MM for month screenshots. Defaults to current month.")
    parser.add_argument("--selector", default="main")
    parser.add_argument("--locale", default="zh-CN")
    parser.add_argument("--output-file", default=None)
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--root", default=None, help="CYBERBOSS_WORKSPACE_ROOT override.")
    parser.add_argument("--account", default=None, help="CYBERBOSS_ACCOUNT_ID override. Defaults to cyberboss-main/.env.")
    return parser.parse_args()


def default_output_file(root, range_name, date_value, month_value):
    shot_dir = root / "cyberboss-data" / "timeline" / "screenshots"
    shot_dir.mkdir(parents=True, exist_ok=True)
    if range_name == "day":
        return shot_dir / f"daily-{date_value}.png"
    if range_name == "month":
        return shot_dir / f"monthly-{month_value}.png"
    return shot_dir / f"weekly-{date_value}.png"


def main():
    args = parse_args()
    now = datetime.now()
    date_value = args.date or now.strftime("%Y-%m-%d")
    month_value = args.month or now.strftime("%Y-%m")

    with CyberbossMcpClient(root=args.root, account=args.account) as client:
        if not args.no_build:
            build = client.call_tool("cyberboss_timeline_build", {"locale": args.locale})
            print_json("build", build)

        output_path = Path(args.output_file) if args.output_file else default_output_file(
            client.root, args.range, date_value, month_value
        )
        if not output_path.is_absolute():
            output_path = (client.root / output_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)

        shot_args = {
            "range": args.range,
            "locale": args.locale,
            "selector": args.selector,
            "outputFile": str(output_path),
        }
        if args.range == "day":
            shot_args["date"] = date_value
        if args.range == "month":
            shot_args["month"] = month_value

        shot = client.call_tool("cyberboss_timeline_screenshot", shot_args)
        print_json("screenshot", shot)

        if terminal_file_sent(shot):
            print("TERMINAL_SUCCESS")
            return 0

        fallback_file = output_file_from(shot) or str(output_path)
        if fallback_file and Path(fallback_file).is_file():
            sent = client.call_tool("cyberboss_channel_send_file", {"filePath": fallback_file})
            print_json("send_file", sent)
            if terminal_file_sent(sent):
                print("TERMINAL_SUCCESS")
                return 0

        print(f"OUTPUT_FILE: {fallback_file}")
        print("TERMINAL_FAILURE")
        return 2


if __name__ == "__main__":
    sys.exit(main())
