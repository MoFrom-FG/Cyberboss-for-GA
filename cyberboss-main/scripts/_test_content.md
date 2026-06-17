# GA → 负一屏端到端测试

## 测试链路

| 环节 | 状态 |
|---|---|
| GA Agent | ✅ 就绪 |
| code_run → Node CLI | ✅ 就绪 |
| TodayTaskService | ✅ 就绪 |
| HTTPS → 华为负一屏 | ✅ 200 OK |
| 手机卡片展示 | 🔍 验证中 |

## 关键参数

- **CLI 路径**: `scripts/today-task-push.js`
- **调用方式**: `node scripts/today-task-push.js --title "标题" --result "短状态" --content-file "xxx.md"`
- **result 上限**: 20 字
- **content**: 完整 Markdown，开头从 `# 标题` 开始

## 错误处理契约

```
exit 0 → 推送成功
exit 1 → 网络/推送错误，可重试一次
exit 2 → 参数错误，GA 修正后重试
exit 3 → 配置错误，需用户介入
```

> 本次测试验证 CLA + SOP 方案可行性。
