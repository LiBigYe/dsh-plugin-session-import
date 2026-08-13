# dsh-plugin-session-import

DeepSeek Harness（dsh）插件：把 **claude-code / codex / reasonix / zcode** 的历史聊天记录导入为 dsh 会话（含工作区绑定与工具能力），导入后可直接续聊。

## 功能

- **四种工具解析**：
  - claude-code（含 Claude-3p 新端、中文路径 `.claude.json` 权威映射）
  - codex（新旧两种响应格式，`custom_tool_call` 参数自动从 JS 代码转 JSON）
  - reasonix（旧 CLI + 新桌面版，项目 slug 贪心解码真实路径）
  - zcode（`db.sqlite` 权威索引 + compaction 压缩摘要还原）
- **会话发现**：标题 / 项目名 / 消息数 / 时间齐全，30s 缓存扫描
- **搜索**：按标题 / 项目名过滤（防抖输入）
- **批量导入**：多选会话一次导入，每个会话独立 seed + 工作区绑定
- **工具完整可用**：导入会话自动加入默认 preset scope，25+ 工具（read/edit/glob/grep/pwsh 等）与正常会话一致
- **超长会话保护**：三层保障（内容裁剪 → 消息截断 → 单条兜底），任何长度 / 任何模型窗口都不超限
- **Web UI**：侧边栏「⇩ 导入会话」按钮（明暗主题自适应），导入成功自动关闭
- **命令**：`/import <tool> <path>`（文件或目录批量）

## 安装

```bash
# 1. 安装插件包
npm i dsh-plugin-session-import

# 2. 在 profile 挂载（~/.dsh/profiles/web/cordis.patch.yml）：
# - insert:
#     - id: session-import
#       name: 'dsh-plugin-session-import'

# 3. 重启 dsh web
dsh web
```

## 使用

- 点击侧边栏底部的 **「⇩ 导入会话」** → 选择工具 → 搜索 / 滚动分批加载 → 勾选 → 导入
- 或命令行：`/import codex C:\Users\xxx\.codex\sessions`（目录=批量）
<img width="420" height="1361" alt="image" src="https://github.com/user-attachments/assets/b2bb60eb-dd12-4cdd-ba67-87c64895002a" />
![Uploading image.png…]()

## 会话数据位置

| 工具 | 会话目录 |
|---|---|
| claude-code | `~/.claude/projects/` + `%LOCALAPPDATA%\Claude-3p\claude-code-sessions`（新端） |
| codex | `~/.codex/sessions/` |
| reasonix | `~/.reasonix/sessions/`（CLI）+ `%APPDATA%\reasonix\projects\*\sessions`（桌面版） |
| zcode | `~/.zcode/cli/db/db.sqlite`（权威索引） |

## 导入质量保障

| 能力 | 说明 |
|---|---|
| 工具调用链 | seed 中 assistant/message 承载 tool-call 块，tool/result 紧跟对应调用（含孤儿 result 丢弃、迟到 result 配对），满足 OpenAI/DeepSeek wire 规则 |
| zcode 压缩 | 识别 compaction 标记，摘要正文（summary.body）原样还原为上下文 |
| codex 参数 | `custom_tool_call` 的 JS 代码参数（`tools.exec_command({...})`）自动转成标准 JSON，避免模型学到错误调用格式 |
| 超长截断 | 文本 ≤16K 字符、工具结果 ≤40K 字符裁剪；消息按预算截断（保留开头锚点 + 压缩摘要 + 尾部）；单条超预算一半直接丢弃 |
| 预算自适应 | 按默认模型真实窗口（contextWindow − maxTokens − 25% 余量）动态计算，`DSH_IMPORT_CONTEXT_BUDGET` 可覆盖 |
| cwd 修复 | claude 中文路径（`.claude.json` 权威映射）、reasonix slug 贪心解码——避免 workspace=主目录导致沙箱拒绝 |

## 已知限制

- 图片附件降级为占位文本（部分工具不支持 image block）
- 被截断的历史消息不保留（超长会话的中间轮次丢失，但保留摘要与锚点）
- reasonix 桌面版部分会话标题依赖 `.titles.json`，缺失时回退文件名提取

## 开发

```bash
npm run build      # esbuild 构建 lib/index.js + lib/client.js
npm pack           # 打包验证
```

## License

MIT
