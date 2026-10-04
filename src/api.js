/**
 * 对模型的请求全部从这一个出口走 —— 好审。
 *
 * 这里只认 OpenAI 兼容协议：POST {baseUrl}/chat/completions
 */

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

/**
 * 流式对话。
 *
 * tools 传了就走 function calling：模型可能不输出文字，而是返回一串工具调用。
 * tool_calls 是分片到达的（name 一次给全，arguments 一段段给），要按 index 拼回去。
 *
 * @returns {Promise<{text, reasoning, usage, toolCalls}>}
 */
export async function streamChat({
  baseUrl, key, model, messages, tools, signal,
  onDelta, onReasoning, onUsage,
}) {
  const body = { model, messages, stream: true };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${trimSlash(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${t ? ' · ' + t.slice(0, 400) : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buf = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  const tcMap = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() || '';

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;

      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue; // 半个 JSON，等下一块
      }

      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      if (json.usage) {
        usage = json.usage;
        onUsage?.(usage);
      }

      const d = json.choices?.[0]?.delta || {};

      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        onReasoning?.(reasoning);
      }
      if (d.content) {
        text += d.content;
        onDelta?.(text);
      }

      // 工具调用分片拼装
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0;
          if (!tcMap.has(idx)) {
            tcMap.set(idx, { id: '', type: 'function', function: { name: '', arguments: '' } });
          }
          const cur = tcMap.get(idx);
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = [...tcMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.function.name);

  return { text, reasoning, usage, toolCalls };
}

/**
 * 拉服务商当前的模型列表。OpenAI 兼容协议里这是 GET {baseUrl}/models。
 *
 * 各家的返回格式略有出入，这里把常见几种都兜住：
 *   {data:[{id}]} / {data:["id"]} / {models:[...]} / 直接数组
 *
 * @returns {Promise<string[]>} 去重排好序的模型 id
 */
export async function listModels({ baseUrl, key, signal }) {
  const res = await fetch(`${trimSlash(baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${t ? ' · ' + t.slice(0, 200) : ''}`);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('返回的不是 JSON（这家可能没实现 /models）');
  }

  let arr = [];
  if (Array.isArray(json)) arr = json;
  else if (Array.isArray(json?.data)) arr = json.data;
  else if (Array.isArray(json?.models)) arr = json.models;
  else if (Array.isArray(json?.data?.models)) arr = json.data.models;

  const ids = arr
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.model || m?.name))
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim());

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * 一次性请求（非流式）。压缩历史、生成记忆用。
 * 这些是后台动作，用户不需要看见过程。
 */
export async function chatOnce({
  baseUrl, key, model, messages, maxTokens = 1024, signal,
}) {
  const body = { model, messages, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(`${trimSlash(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${t ? ' · ' + t.slice(0, 300) : ''}`);
  }

  const json = await res.json();
  return {
    text: json.choices?.[0]?.message?.content || '',
    usage: json.usage || null,
  };
}
