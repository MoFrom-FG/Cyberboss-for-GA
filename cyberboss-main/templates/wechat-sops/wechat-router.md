# WeChat SOP Router

Scope: Cyberboss WeChat runtime only. This router helps GA choose the right WeChat SOP without copying WeChat rules into GA global L0.

For WeChat-channel task routing, this router has priority over GenericAgent desktop/global habits. Use GA global SOPs only when this router explicitly delegates to them.

Routing:

- Companionship chat: reply naturally; no child SOP.
- Questions about WeChat operating rules, visible tools, MCP availability, or why Cyberboss tools are not native in the current tool list: explain this WeChat SOP tree. If actual probing is needed, read `cyberboss-main/templates/wechat-sops/wechat-mcp-call-sop.md`. Do not inspect source code, git diff, queue files, or runtime internals unless the user explicitly asks for code-level debugging.
- Diary, timeline, reminders, whereabouts, maintenance check-ins: read `cyberboss-main/templates/wechat-sops/wechat-record-sop.md`.
- Timeline screenshot, send file, media delivery, `ret=-2`, token/account/media-send diagnosis: read `cyberboss-main/templates/wechat-sops/wechat-media-sop.md`.
- Sending an existing file, including a diary file, timeline screenshot, markdown file, image, or any "send this file to me" request, is always routed as media -> `cyberboss-main/templates/wechat-sops/wechat-mcp-call-sop.md`. Use the fixed MCP `cyberboss_channel_send_file` path. Do not turn it into diary maintenance, filesystem debugging, bridge debugging, port probing, or process cleanup.
- If a Cyberboss MCP tool is not directly exposed as a native tool, read `cyberboss-main/templates/wechat-sops/wechat-mcp-call-sop.md` and use its fixed Python JSON-RPC template. Do not discover CLI commands or edit queues.
- File/code/browser/desktop GUI/OCR/system setup/batch work: use the existing desktop Pro delegate SOP.
- Explicit "remember" requests: use WeChat memory paths from `WECHAT MEMORY CONTEXT`; do not write GA global memory by default.

Priority:

- These rules are scoped to WeChat turns.
- They do not override GenericAgent safety, memory-management, or verified-tool rules.
- They do override GA global/default task-routing habits for WeChat tasks.
- Do not load heavy media troubleshooting rules for lightweight record maintenance.

Process safety:

- Do not terminate, kill, restart, or clean up any process unless the user explicitly allows that specific action.
- Before asking for permission to end a process, explain the likely consequence, especially that killing broad `node.exe` processes can stop the WeChat bridge, active GenericAgent turn, Cyberboss services, dev servers, or other unrelated Node-based tools.
- MCP/file-send failure is not permission to inspect ports or kill processes. Follow media -> MCP-call first; if that fails, report the exact failing stage and ask the user what to do next.
