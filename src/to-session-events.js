/**
 * 结构化消息列表 → dsh SessionEvent[]（seed 格式，从 seq 0 连续、turn/step 闭合）。
 *
 * 事件序列模型（每轮合法结构）：
 *   turn/start → step/start → user/message → step/end
 *             → step/start → (assistant/message 含 tool-call 块 + tool/call + tool/result)* → step/end
 *             → turn/end
 *
 * 关键约束（OpenAI/DeepSeek chat-completions wire 规则）：
 *   - assistant 消息的 content 必须承载 tool-call 块（转成 API 的 tool_calls 字段）
 *   - 每条 role='tool' 消息必须【紧邻】其对应的 tool_calls 消息（中间不能插入其他 assistant）
 *   - 因此 tool/result 必须紧跟其 tool-call 的 assistant 载体输出——
 *     解析器可能把多个 tool-call 的 assistant 消息连续输出、结果后置
 *     （claude 格式：assistant[callA] assistant[callB] user[resultA] user[resultB]），
 *     必须按 callId 重排：assistant(A)+tool(A) → assistant(B)+tool(B)。
 */

let seq = 0
let turn = 0
let step = 0
let turnOpen = false
let stepOpen = false
let baseTime = 0

function reset() {
  seq = 0; turn = 0; step = 0; turnOpen = false; stepOpen = false
  baseTime = Date.now()
}

/** 追加一个事件，自动分配 seq/time */
function push(type, data, extra) {
  return { type, seq: seq++, time: baseTime + seq, data, ...(extra ?? {}) }
}

function openTurn() {
  turn += 1
  step = 0
  turnOpen = true
  return push('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
}

function closeTurn() {
  if (!turnOpen) return []
  turnOpen = false
  return [push('turn/end', { turn, reason: { kind: 'completed' } })]
}

function openStep() {
  step += 1
  stepOpen = true
  return push('step/start', { turn, step })
}

function closeStep() {
  if (!stepOpen) return []
  stepOpen = false
  return [push('step/end', { turn, step })]
}

/**
 * 转换器：把消息流重排为「assistant 载体紧跟其 tool 结果」的合法序列。
 * 实现：遍历消息，assistant 消息先缓存（不立即输出其 tool-call），
 * 遇到 tool-result 时把对应 assistant 载体 + tool/call + tool/result 一起输出；
 * 遇到新的纯 user 文本消息时，把未闭合的 assistant 载体强制输出（dangling call 兜底）。
 */
export function toSessionEvents(messages) {
  reset()
  const events = []
  /** pending assistant 载体：{ content, model, usage, calls: Map<callId, block> } */
  let pending = null
  /** 已随 assistant 载体输出的 call id（用于匹配迟到的 result；跨 turn 后清空） */
  let flushedCalls = new Set()

  const flushPending = () => {
    if (!pending) return
    if (!turnOpen) events.push(openTurn())
    events.push(openStep())
    const content = [...pending.textBlocks, ...pending.calls]
    if (content.length > 0) {
      events.push(push('assistant/message', {
        turn, step,
        message: {
          id: `import-assistant-${seq}`,
          role: 'assistant',
          content,
          source: { kind: 'model', provider: 'imported', model: pending.model ?? 'imported' },
        },
        ...(pending.usage
          ? { usage: {
              inputTokens: Number(pending.usage.input_tokens ?? 0) || 0,
              outputTokens: Number(pending.usage.output_tokens ?? 0) || 0,
              ...(Number(pending.usage.cache_read_input_tokens ?? 0) ? { cacheReadTokens: Number(pending.usage.cache_read_input_tokens) } : {}),
              ...(Number(pending.usage.cache_creation_input_tokens ?? 0) ? { cacheWriteTokens: Number(pending.usage.cache_creation_input_tokens) } : {}),
              ...(Number(pending.usage.reasoning_tokens ?? 0) ? { reasoningTokens: Number(pending.usage.reasoning_tokens) } : {}),
            } }
          : {}),
      }, { surfaceOp: 'append' }))
    }
    for (const block of pending.calls) {
      events.push(push('tool/call', {
        turn, step,
        callId: block.id,
        name: block.name,
        arguments: block.arguments,
      }))
      flushedCalls.add(block.id)
    }
    events.push(...closeStep())
    pending = null
  }

  /** 输出一个 tool/result，紧跟在对应 assistant 载体之后（同 step） */
  const emitToolResult = (block) => {
    if (!turnOpen) events.push(openTurn())
    if (!stepOpen) events.push(openStep())
    events.push(push('tool/result', {
      turn, step,
      message: {
        id: `import-tool-${seq}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: block.toolCallId, content: block.content, isError: block.isError === true }],
        source: { kind: 'tool', callId: block.toolCallId },
      },
    }, { surfaceOp: 'append' }))
  }

  for (const message of messages) {
    const tools = message.content.filter((b) => b.type === 'tool-call' || b.type === 'tool-result')
    const textBlocks = message.content.filter((b) => b.type === 'text' || b.type === 'reasoning' || b.type === 'image')
    const calls = tools.filter((b) => b.type === 'tool-call')
    const results = tools.filter((b) => b.type === 'tool-result')

    if (message.role === 'assistant') {
      // 连续 assistant 消息合并到同一 pending（同一轮的工具调用序列，
      // 结果可能后置在后续 user 消息里——如 claude 的 tool_use 逐条输出）
      if (!pending) {
        pending = { textBlocks: [], calls: [], model: undefined, usage: undefined }
      }
      pending.textBlocks.push(...textBlocks)
      for (const c of calls) pending.calls.push(c)
      if (!pending.model && message.model) pending.model = message.model
      if (!pending.usage && message.usage) pending.usage = message.usage
      // 若该 assistant 消息自带 tool-result（如 zcode 的 call+result 成对），立即配对输出
      if (results.length > 0 && pending.calls.length > 0) {
        flushPending()
        for (const r of results) emitToolResult(r)
      }
      continue
    }

    if (message.role === 'user') {
      if (results.length > 0) {
        // 工具结果：匹配 pending 或已 flush 的 call 则输出；真孤儿（从未出现的 call）丢弃
        const pendingCallIds = new Set((pending?.calls ?? []).map((c) => c.id))
        const matched = []
        const orphans = []
        for (const r of results) {
          if (pendingCallIds.has(r.toolCallId) || flushedCalls.has(r.toolCallId)) matched.push(r)
          else orphans.push(r)
        }
        if (orphans.length > 0) {
          console.log(`[session-import] 丢弃 ${orphans.length} 个孤儿工具结果（无对应调用）`)
        }
        if (matched.length > 0) {
          if (pending && pending.calls.length > 0) flushPending()
          for (const r of matched) emitToolResult(r)
        }
        // 若该 user 消息还带文本（纯文本 + tool-result 混合），追加 user/message
        const realText = textBlocks.filter((b) => b.type === 'text' && b.text.trim())
        if (realText.length > 0) {
          if (!turnOpen) events.push(openTurn())
          if (!stepOpen) events.push(openStep())
          events.push(push('user/message', {
            id: `import-user-${seq}`,
            role: 'user',
            content: textBlocks,
            source: { kind: 'user' },
          }, { surfaceOp: 'append' }))
          events.push(...closeStep())
        }
        continue
      }
      // 纯用户文本消息：新开一轮（先 flush 未闭合的 assistant 载体）
      if (pending && pending.calls.length > 0) flushPending()
      flushedCalls = new Set() // 跨 turn，旧 call 不再可匹配
      const text = textBlocks.map((b) => b.text ?? '').join('')
      if (text.includes('<system-reminder>') && !text.replace(/<[^>]+>/g, '').trim()) continue // 过滤纯系统注入
      events.push(...closeTurn(), openTurn(), openStep())
      events.push(push('user/message', {
        id: `import-user-${seq}`,
        role: 'user',
        content: textBlocks,
        source: { kind: 'user' },
      }, { surfaceOp: 'append' }))
      events.push(...closeStep())
    }
  }
  // 结尾：flush 未闭合的 assistant 载体（dangling tool-call 兜底，保证 seed 完整）
  flushPending()
  events.push(...closeTurn())
  return events
}
