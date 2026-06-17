import json
import sys
sys.path.insert(0, '.')
from mcp_client import CyberbossMcpClient

with CyberbossMcpClient() as client:
    result = client.request('tools/list', {})
    for tool in result['result']['tools']:
        name = tool['name']
        schema = json.dumps(tool.get('inputSchema', {}), ensure_ascii=False)
        print(f"{name}: {schema[:500]}")
        print("---")
