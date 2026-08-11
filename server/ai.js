// Optional AI fallback: only runs when ANTHROPIC_API_KEY is set.
// Takes lines the deterministic parser could not read and asks Claude
// to return structured JSON. Kept cheap (Haiku by default, batched).

import Anthropic from "@anthropic-ai/sdk";

const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

export const aiEnabled = () => Boolean(KEY);

export async function aiParse(lines) {
  if (!KEY || !lines.length) return [];
  const client = new Anthropic({ apiKey: KEY });

  const prompt = `You are a proxy-list parser. For each input line, extract the proxy.
Return ONLY a JSON array, no prose, no markdown. Each element:
{"host": "", "port": "", "username": "", "password": "", "proxy_type": "http" | "socks5", "raw": "<original line>"}
If a line is not a proxy, omit it. Ports are 1-65535. Default proxy_type to "http" unless the line clearly indicates socks.

Lines:
${lines.map((l) => `- ${l}`).join("\n")}`;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error("[ai] parse failed:", e.message);
    return [];
  }
}
