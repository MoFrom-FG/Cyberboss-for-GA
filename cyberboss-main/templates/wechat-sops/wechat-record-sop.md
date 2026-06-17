# WeChat Record SOP

Use this SOP for diary, timeline, reminders, whereabouts, and system maintenance check-ins. This is the lightweight path. Do not read media/token/screenshot troubleshooting rules here.

If Cyberboss MCP tools are not directly exposed as native tools, use `cyberboss-main/templates/wechat-sops/wechat-mcp-call-sop.md` and prefer the fixed scripts under `cyberboss-main/templates/wechat-sops/python-sops/` before writing inline Python. Do not read or edit diary/timeline JSON or Markdown files directly.

Preferred scripts:

- Diary append: `python cyberboss-main/templates/wechat-sops/python-sops/diary_append.py --text "<entry>"`
- Generic record tools: `python cyberboss-main/templates/wechat-sops/python-sops/mcp_tool.py --tool <tool-name> --arguments-json "<json-object>"`

## Life Event Signal

Treat these categories as timeline-capable time blocks: life, work, study, exercise, entertainment, health, social, care, travel, rest.

Write timeline when the recent conversation contains concrete time-block facts such as meals, sleep, wake-up, coding, study, exercise, games, health symptoms, medication, travel, chores, care, or social time. Timeline records facts and time ranges, not emotional prose.

Write diary only when the same context has state, emotion, decisions, relationship meaning, day-level continuity, or a useful future handle. Diary is not a transcript.

Examples:

- "I ate KFC" -> timeline only, unless it matters to the day's state.
- "I worked on code all afternoon and feel exhausted" -> timeline plus diary.
- "I am going to sleep" -> sleep timeline; if the day has meaningful unresolved context, do a diary pass.
- Major health or life decisions -> timeline when time-bounded, diary when meaningful, and consider WeChat user memory only after confirmation.

## Tool Rules

- Timeline: use `cyberboss_timeline_read` and `cyberboss_timeline_write`; never edit timeline JSON files directly. For WeChat timeline writes, use Beijing local wall-clock time with an explicit `+08:00` offset, for example `2026-06-03T14:30:00+08:00`; do not convert the clock time to UTC or pass `Z` timestamps.
- Diary: use `cyberboss_diary_append`; keep entries concise and useful for future continuity.
- Reminders: use `cyberboss_reminder_create` when there is a clear future checkpoint or follow-up.
- Whereabouts: use whereabouts tools only when location context is relevant.

Before changing an existing timeline day, read that day first. When adding a clearly new event and enough context is already available, write directly with existing category/subcategory/eventNode ids when obvious. If classification is uncertain, inspect categories.

Timeline events must stay within the target Beijing date. Split cross-day sleep into separate day events.

## Maintenance Check-ins

In `SYSTEM MAINTENANCE MODE`, first decide whether the dirty signal supports timeline, diary, or both. If enough information exists, call the relevant MCP tool before replying. If there is not enough information to write safely, use `silent` or ask one short clarification only when the user needs to decide.

After maintenance, return exactly one JSON object requested by the system message. Do not describe tool internals, queue ids, file paths, or maintenance state unless a failure requires it.

For runnable Python MCP examples for diary and timeline read/write, use `cyberboss-main/templates/wechat-sops/wechat-mcp-call-sop.md`. Prefer the checked-in scripts there over hand-written Python.
