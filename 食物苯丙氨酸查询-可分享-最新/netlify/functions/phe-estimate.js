// Netlify Serverless Function: 表中查不到时用大模型估算苯丙氨酸含量
// 支持：DeepSeek（推荐，有免费额度）、Kimi、豆包、OpenAI
// 在 Netlify 后台设置环境变量，见下方 getLLMConfig()

const PROMPT = `你是一个营养数据助手。用户查询「每100克可食部分」某种食物的苯丙氨酸含量（单位：毫克 mg）。
请仅根据营养学常识给出合理估算值。若无法估算或不确定，phePer100 填 null。
必须只返回一个合法 JSON，不要其他文字。格式：
{"phePer100": 数字或null, "note": "一句话说明依据或不确定性"}

食物名称：`;

function getLLMConfig() {
  const provider = (process.env.LLM_PROVIDER || "deepseek").toLowerCase();
  const configs = {
    deepseek: {
      key: process.env.DEEPSEEK_API_KEY,
      url: "https://api.deepseek.com/v1/chat/completions",
      model: "deepseek-chat",
      name: "DeepSeek",
    },
    kimi: {
      key: process.env.MOONSHOT_API_KEY,
      url: "https://api.moonshot.cn/v1/chat/completions",
      model: "moonshot-v1-8k",
      name: "Kimi",
    },
    doubao: {
      key: process.env.DOUBAO_API_KEY,
      url: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      model: process.env.DOUBAO_ENDPOINT_ID || "",
      name: "豆包",
    },
    openai: {
      key: process.env.OPENAI_API_KEY,
      url: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      name: "OpenAI",
    },
  };
  const cfg = configs[provider] || configs.deepseek;
  if (provider === "doubao" && !cfg.model) {
    return { ...cfg, key: null, error: "豆包需同时设置 DOUBAO_ENDPOINT_ID（推理接入点 ID）" };
  }
  return cfg;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  const cors = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" };
  const cfg = getLLMConfig();
  if (!cfg.key) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: cfg.error || "未配置 API Key。DeepSeek: DEEPSEEK_API_KEY；Kimi: MOONSHOT_API_KEY；豆包: DOUBAO_API_KEY + DOUBAO_ENDPOINT_ID；OpenAI: OPENAI_API_KEY",
        source: "config",
      }),
    };
  }
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "请求体不是合法 JSON" }) };
  }
  const food = (body.food || "").trim();
  if (!food) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "请提供食物名称 food" }) };
  }

  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.key,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: PROMPT + food }],
        temperature: 0.2,
        max_tokens: 200,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      return {
        statusCode: res.status,
        headers: cors,
        body: JSON.stringify({ error: "大模型请求失败", detail: t.slice(0, 200), source: "api" }),
      };
    }
    const data = await res.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    let phePer100 = null;
    let note = "";
    try {
      const jsonStr = content.replace(/```json?\s*|\s*```/g, "").trim();
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.phePer100 === "number" && !isNaN(parsed.phePer100)) {
        phePer100 = Math.round(parsed.phePer100 * 10) / 10;
      }
      if (typeof parsed.note === "string") note = parsed.note;
    } catch (_) {
      note = "解析回复失败，请重试";
    }
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ phePer100, note, source: "ai", provider: cfg.name }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: String(err.message), source: "server" }),
    };
  }
};
