# Claude Code Discord Bot - 变更记录

## 日期：2026-03-15

---

## 概述

本次更新为 Discord Bot 添加了 OpenAI Codex 支持，实现 Claude 和 Codex 双 AI 提供商架构。用户可以在每个频道独立选择 AI 提供商，并统一管理两种提供商的会话。

---

## 新增功能

### 1. 多提供商架构

#### 1.1 提供商抽象层 (`src/providers/`)
- **新增 `base.ts`**: 定义 `AgentProvider` 接口，统一 Claude 和 Codex 的调用方式
- **新增 `index.ts`**: 提供商工厂函数，根据名称创建对应提供商实例
- **新增 `codex.ts`**: Codex 提供商完整实现
  - 使用 `@openai/codex-sdk` 的 `Codex` 类
  - 支持 `startThread()` 和 `resumeThread()`
  - 配置 `sandboxMode: "workspace-write"` 允许文件编辑
  - 配置 `skipGitRepoCheck: true` 跳过 git 仓库检查

#### 1.2 数据库扩展
- `projects` 表新增 `provider` 列（"claude" | "codex"）
- 支持按提供商过滤和查询项目

#### 1.3 配置更新
- `.env.example` 新增：
  - `DEFAULT_PROVIDER`: 默认 AI 提供商（claude/codex）
  - `OPENAI_API_KEY`: OpenAI API 密钥（可选，Codex 主要使用 CLI 认证）

---

### 2. Codex 会话管理

#### 2.1 会话列表 (`src/bot/commands/sessions.ts`)

**文件结构差异：**

| 提供商 | 存储路径 | 文件名格式 |
|--------|----------|------------|
| Claude | `~/.claude/projects/<encoded-path>/` | `<uuid>.jsonl` |
| Codex | `~/.codex/sessions/<year>/<month>/<day>/` | `rollout-<timestamp>-<uuid>.jsonl` |

**关键实现：**

```typescript
// 递归查找所有 .jsonl 文件
function findAllCodexSessionFiles(dir: string): string[]

// 从 session_meta.payload.cwd 读取项目路径
async function getCodexSessionProjectPath(eventsFile: string): Promise<string | null>

// 从 event_msg.payload.message 读取用户消息
async function getCodexFirstMessage(filePath: string): Promise<{ text: string; timestamp: string }>
```

**用户消息提取优先级：**
1. `event_msg` with `type === "user_message"` - 实际用户输入
2. `response_item` with `role === "user"` - 过滤掉 AGENTS.md 内容（长度 < 500）
3. `turn_context.payload.summary` - 回退选项

#### 2.2 会话删除 (`src/bot/commands/clear-sessions.ts`, `interaction.ts`)

- **Claude**: 直接删除 `~/.claude/projects/<project>/<sessionId>.jsonl`
- **Codex**: 递归查找文件名包含 UUID 的 `.jsonl` 文件并删除
- 删除当前激活会话时，自动重置数据库状态

#### 2.3 交互式操作

选择会话后显示三个按钮：
- ▶️ **Resume**: 恢复会话
- 🗑️ **Delete**: 删除会话
- ❌ **Cancel**: 取消操作

---

### 3. 消息输出流程优化

#### 3.1 流式输出改进 (`src/claude/session-manager.ts`)

**旧流程：**
1. 流式传输文本（带 Stop 按钮）
2. 发送相同文本的 result embed 卡片（重复显示）

**新流程：**
1. 流式传输文本（带 Stop 按钮）
2. 流式结束后，清空消息内容，替换为 Completed 按钮
3. 单独发送格式化的 result embed 卡片

```typescript
// 结果处理
if (message.type === "result") {
  // 替换流式消息为 Completed 按钮
  await currentMessage.edit({
    content: "",
    components: [createCompletedButton()],
  });

  // 发送结果卡片
  const resultEmbed = createResultEmbed(
    message.text,
    message.cost ?? 0,
    message.durationMs ?? 0,
    getConfig().SHOW_COST,
  );
  await channel.send({ embeds: [resultEmbed] });
}
```

---

## 技术细节

### Codex JSONL 文件结构

```json
// session_meta - 会话元数据
{"type": "session_meta", "payload": {"cwd": "/path/to/project", "timestamp": "..."}}

// turn_context - 回合上下文（summary 通常为 "none"）
{"type": "turn_context", "payload": {"summary": "none", "user_instructions": "...AGENTS.md内容..."}}

// event_msg - 实际用户消息
{"type": "event_msg", "payload": {"type": "user_message", "message": "用户实际输入"}}

// response_item - 助手回复
{"type": "response_item", "payload": {"role": "assistant", "content": [{"type": "output_text", "text": "回复内容"}]}}
```

### 路径标准化

Codex 和 Claude 的路径格式可能不同（末尾斜杠等），使用 `path.normalize()` 进行统一比较：

```typescript
const normalizedSessionPath = path.normalize(sessionProjectPath);
const normalizedProjectPath = path.normalize(projectPath);
if (normalizedSessionPath !== normalizedProjectPath) continue;
```

---

## 文件变更列表

### 新增文件
- `src/providers/base.ts` - 提供商接口定义
- `src/providers/index.ts` - 提供商工厂
- `src/providers/codex.ts` - Codex 提供商实现
- `src/bot/commands/switch-model.ts` - 切换模型命令

### 修改文件
- `src/bot/commands/sessions.ts` - 支持双提供商会话列表
- `src/bot/commands/clear-sessions.ts` - 支持删除 Codex 会话
- `src/bot/commands/register.ts` - 新增 provider 字段支持
- `src/bot/handlers/interaction.ts` - 删除按钮和会话恢复逻辑
- `src/claude/session-manager.ts` - 消息输出流程优化
- `src/db/database.ts` - 添加 provider 列支持
- `src/db/types.ts` - 类型定义更新
- `src/utils/config.ts` - 新增配置项
- `.env.example` - 新增环境变量示例
- `package.json` - 添加 `@openai/codex-sdk` 依赖

---

## 使用说明

### 注册频道到 Codex

```
/register /path/to/project codex
```

### 切换现有项目提供商

```
/switch-model codex
```

### 查看会话列表

```
/sessions
```

显示当前项目的所有会话，支持：
- 创建新会话
- 恢复已有会话
- 删除会话

### 清除所有会话

```
/clear-sessions
```

---

## 注意事项

1. **Codex 认证**：使用 Codex CLI 的设备码认证（存储在 `~/.codex/`）
2. **会话文件大小过滤**：小于 512 字节的文件被视为空/废弃会话，自动跳过
3. **路径匹配**：支持 `cwd` 和 `working_directory` 两种字段名
4. **时区**：Codex 会话文件名中的时间戳使用 UTC，显示时转换为本地时间

---

## 依赖更新

```json
{
  "dependencies": {
    "@openai/codex-sdk": "^0.114.0"
  }
}
```

安装命令：
```bash
npm install
```

---

*本次更新由 Claude Code 协助完成*
