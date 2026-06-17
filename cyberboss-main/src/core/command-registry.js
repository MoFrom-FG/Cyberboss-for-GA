const COMMAND_GROUPS = [
  {
    id: "lifecycle",
    label: "Lifecycle & Diagnostics",
    actions: [
      {
        action: "app.login",
        summary: "Start WeChat QR login and save the account",
        terminal: ["login"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.accounts",
        summary: "List locally saved accounts",
        terminal: ["accounts"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.start",
        summary: "Start the current channel/runtime main loop",
        terminal: ["start"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_start",
        summary: "Start the shared app-server and shared WeChat bridge",
        terminal: ["shared start"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_open",
        summary: "Attach to the shared thread currently bound in WeChat",
        terminal: ["shared open"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_status",
        summary: "Show the shared app-server and bridge status",
        terminal: ["shared status"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.doctor",
        summary: "Print current config, boundaries, and thread state",
        terminal: ["doctor"],
        weixin: [],
        status: "active",
      },
      {
        action: "system.send",
        summary: "Write an invisible trigger message into the internal system queue",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "system.checkin_poller",
        summary: "Emit proactive check-in triggers at random intervals",
        terminal: [],
        weixin: [],
        status: "active",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace & Thread",
    actions: [
      {
        action: "workspace.bind",
        summary: "Bind the current chat to a workspace directory",
        terminal: [],
        weixin: ["/bind"],
        status: "active",
      },
      {
        action: "workspace.status",
        summary: "Show the current workspace, thread, model, and context usage",
        terminal: [],
        weixin: ["/status"],
        status: "active",
      },
      {
        action: "thread.new",
        summary: "Switch to a fresh thread draft",
        terminal: [],
        weixin: ["/new"],
        status: "active",
      },
      {
        action: "thread.reread",
        summary: "Make the current thread reread the latest instructions",
        terminal: [],
        weixin: ["/reread"],
        status: "active",
      },
      {
        action: "thread.switch",
        summary: "Switch to a specific thread",
        terminal: [],
        weixin: ["/switch <threadId>"],
        status: "active",
      },
      {
        action: "thread.stop",
        summary: "Stop the current run inside the thread",
        terminal: [],
        weixin: ["/stop"],
        status: "active",
      },
      {
        action: "system.checkin_range",
        summary: "Reset the proactive check-in range in minutes",
        terminal: [],
        weixin: ["/checkin <min>-<max>"],
        status: "active",
      },
      {
        action: "thread.turn_progress",
        summary: "Show, enable, or disable intermediate turn replies",
        terminal: [],
        weixin: ["/turn status", "/turn on", "/turn off"],
        status: "active",
      },
      {
        action: "channel.chunk_min",
        summary: "Adjust the minimum short-chunk merge size for WeChat replies",
        terminal: [],
        weixin: ["/chunk <number>"],
        status: "active",
      },
    ],
  },
  {
    id: "profile",
    label: "Profile Settings",
    actions: [
      {
        action: "profile.user_name",
        summary: "Set or show the configured user name",
        terminal: [],
        weixin: ["/name <userName>"],
        status: "active",
      },
      {
        action: "profile.user_gender",
        summary: "Set or show the configured user gender",
        terminal: [],
        weixin: ["/gender <female|male|neutral>"],
        status: "active",
      },
      {
        action: "profile.bot_name",
        summary: "Set or show the configured bot name",
        terminal: [],
        weixin: ["/botname <botName>"],
        status: "active",
      },
    ],
  },
  {
    id: "approval",
    label: "Approvals & Control",
    actions: [
      {
        action: "approval.accept_once",
        summary: "Allow the current approval request once",
        terminal: [],
        weixin: ["/yes"],
        status: "active",
      },
      {
        action: "approval.accept_workspace",
        summary: "Keep allowing matching command prefixes in the current workspace",
        terminal: [],
        weixin: ["/always"],
        status: "active",
      },
      {
        action: "approval.reject_once",
        summary: "Deny the current approval request",
        terminal: [],
        weixin: ["/no"],
        status: "active",
      },
    ],
  },
  {
    id: "capabilities",
    label: "Capabilities",
    actions: [
      {
        action: "model.inspect",
        summary: "Inspect the current model",
        terminal: [],
        weixin: ["/model"],
        status: "active",
      },
      {
        action: "model.select",
        summary: "Switch to a specific model",
        terminal: [],
        weixin: ["/model <id>"],
        status: "active",
      },
      {
        action: "channel.send_file",
        summary: "Send a local file back to the current chat as an attachment",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.write",
        summary: "Write the current context into timeline",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.build",
        summary: "Build the static timeline site",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.serve",
        summary: "Start the static timeline site server",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.dev",
        summary: "Start the hot-reload timeline dev server",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.screenshot",
        summary: "Capture a timeline screenshot",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "reminder.create",
        summary: "Create a reminder and hand it to the scheduler",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "diary.append",
        summary: "Append a diary entry",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "app.help",
        summary: "Show currently available commands for this channel",
        summaryZh: "显示当前微信可用指令",
        terminal: ["help"],
        weixin: ["/help"],
        status: "active",
      },
    ],
  },
];

function listCommandGroups() {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    actions: group.actions.map((action) => ({ ...action })),
  }));
}

function buildTerminalHelpText() {
  const lines = [
    "Usage: cyberboss <command>",
    "",
    "Current terminal commands:",
    "  cyberboss start        start the WeChat bridge and runtime loop",
    "  cyberboss login        start WeChat QR login",
    "  cyberboss accounts     list locally saved accounts",
    "  cyberboss doctor       print current config and thread state",
    "  npm run shared:start   start the shared app-server and WeChat bridge",
    "  npm run shared:open    attach to the shared thread currently bound in WeChat",
    "  npm run shared:status  show shared bridge status",
  ];

  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => action.status === "active" && action.terminal.length);
    if (!activeActions.length) {
      continue;
    }
    lines.push(`- ${group.label}`);
    for (const action of activeActions) {
      lines.push(`  ${formatTerminalExamples(action)}  ${action.summary}`);
    }
  }

  lines.push("");
  lines.push("Cyberboss capability operations are exposed to models as project tools, not terminal subcommands.");
  return lines.join("\n");
}

function buildWeixinHelpText(config = {}) {
  const useZh = Boolean(config?.helpZh);
  const lines = [useZh ? "💡 可用指令：" : "💡 Available commands:"];
  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => action.status === "active" && action.weixin.length);
    if (!activeActions.length) {
      continue;
    }
    lines.push("");
    lines.push(`${groupEmoji(group.id)} 【${groupLabel(group, useZh)}】`);
    for (const action of activeActions) {
      lines.push(`  ${actionEmoji(action)} ${action.weixin.join(", ")} - ${actionSummary(action, useZh)}`);
    }
  }
  return lines.join("\n");
}

function groupLabel(group, useZh = false) {
  if (!useZh) {
    return group.label;
  }
  switch (group.id) {
    case "lifecycle": return "生命周期与诊断";
    case "workspace": return "工作区与线程";
    case "profile": return "个人配置";
    case "approval": return "审批与控制";
    case "capabilities": return "能力";
    default: return group.label;
  }
}

function actionSummary(action, useZh = false) {
  if (!useZh) {
    return action.summary;
  }
  if (action.summaryZh) {
    return action.summaryZh;
  }
  switch (action.action) {
    case "workspace.bind": return "绑定当前聊天到工作区目录";
    case "workspace.status": return "查看当前工作区、线程、模型和上下文状态";
    case "thread.new": return "切换到新的线程草稿";
    case "thread.reread": return "让当前线程重新读取最新指令";
    case "thread.switch": return "切换到指定线程";
    case "thread.stop": return "停止当前线程里的运行任务";
    case "system.checkin_range": return "设置主动 check-in 间隔，单位分钟";
    case "thread.turn_progress": return "查看、开启或关闭中间 turn 回复显示";
    case "channel.chunk_min": return "调整微信短回复合并的最小字符数";
    case "profile.user_name": return "设置或查看用户名字";
    case "profile.user_gender": return "设置或查看用户性别";
    case "profile.bot_name": return "设置或查看机器人名字";
    case "approval.accept_once": return "允许当前审批请求一次";
    case "approval.accept_workspace": return "持续允许当前工作区内匹配的命令前缀";
    case "approval.reject_once": return "拒绝当前审批请求";
    case "model.inspect": return "查看当前模型";
    case "model.select": return "切换到指定模型";
    case "app.help": return "显示当前微信可用指令";
    default: return action.summary;
  }
}

function groupEmoji(groupId) {
  switch (groupId) {
    case "lifecycle": return "🔄";
    case "workspace": return "📁";
    case "profile": return "👤";
    case "approval": return "🔐";
    case "capabilities": return "⚡️";
    default: return "•";
  }
}

function actionEmoji(action) {
  switch (action.action) {
    case "workspace.bind": return "📍";
    case "workspace.status": return "📊";
    case "thread.new": return "🆕";
    case "thread.reread": return "🔄";
    case "thread.switch": return "🔀";
    case "thread.stop": return "⏹️";
    case "system.checkin_range": return "⏰";
    case "thread.turn_progress": return "📣";
    case "channel.chunk_min": return "🧩";
    case "profile.user_name":
    case "profile.user_gender":
    case "profile.bot_name": return "👤";
    case "approval.accept_once": return "✅";
    case "approval.accept_workspace": return "💡";
    case "approval.reject_once": return "❌";
    case "model.inspect":
    case "model.select": return "🤖";
    case "app.help": return "❓";
    default: return "•";
  }
}

module.exports = {
  buildTerminalHelpText,
  buildWeixinHelpText,
  listCommandGroups,
};

function formatTerminalExamples(action) {
  const terminal = Array.isArray(action?.terminal) ? action.terminal : [];
  if (!terminal.length) {
    return "";
  }
  return terminal.map((commandText) => toTerminalCommandExample(commandText)).join(", ");
}

function toTerminalCommandExample(commandText) {
  const normalized = typeof commandText === "string" ? commandText.trim() : "";
  switch (normalized) {
    case "login":
    case "accounts":
    case "start":
    case "doctor":
    case "help":
      return `cyberboss ${normalized}`;
    case "shared start":
    case "shared open":
    case "shared status":
      return `npm run ${normalized.replace(" ", ":")}`;
    case "start --checkin":
      return "cyberboss start --checkin";
    default:
      return normalized;
  }
}
