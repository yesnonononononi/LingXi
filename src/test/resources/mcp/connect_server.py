import json
import os
import sys

# 只实现连接测试需要的协议；工具执行一律拒绝。
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    response = {"jsonrpc": "2.0", "id": request["id"]}
    if method == "initialize":
        response["result"] = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "connection-fixture", "version": "1.0"},
        }
    elif method == "tools/list":
        response["result"] = {"tools": [{
            "name": os.getenv("MCP_TEST_TOOL", "fixture_echo"),
            "description": "连接测试工具",
            "inputSchema": {"type": "object", "properties": {}},
        }]}
    elif method == "ping":
        response["result"] = {}
    else:
        response["error"] = {"code": -32601, "message": "Method not found"}
    print(json.dumps(response), flush=True)
