// Deterministic proxy-line parser. Handles the common real-world shapes:
//   host:port
//   host:port:user:pass
//   user:pass:host:port
//   user:pass@host:port
//   host:port@user:pass
//   scheme://user:pass@host:port   (http, https, socks5)
//   whitespace- / comma- / tab-separated variants
// Returns { host, port, username, password, proxy_type } or null if unsure.

const isPort = (t) => /^\d{2,5}$/.test(t) && +t >= 1 && +t <= 65535;
const looksHost = (t) =>
  /^[a-z0-9.-]+$/i.test(t) && (t.includes(".") || /^[a-z]/i.test(t));

function detectType(line) {
  const m = line.match(/^(socks5?|https?):\/\//i);
  if (!m) return { type: "http", rest: line };
  const scheme = m[1].toLowerCase();
  const type = scheme.startsWith("socks") ? "socks5" : "http";
  return { type, rest: line.slice(m[0].length) };
}

// Given exactly [host, port, user, pass] in unknown order across two halves.
function fromTokens(tokens, type) {
  if (tokens.length === 2) {
    const [a, b] = tokens;
    if (looksHost(a) && isPort(b)) return mk(a, b, "", "", type);
    return null;
  }
  if (tokens.length === 4) {
    // host:port:user:pass  (port in slot 1)
    if (looksHost(tokens[0]) && isPort(tokens[1]))
      return mk(tokens[0], tokens[1], tokens[2], tokens[3], type);
    // user:pass:host:port  (port in slot 3)
    if (looksHost(tokens[2]) && isPort(tokens[3]))
      return mk(tokens[2], tokens[3], tokens[0], tokens[1], type);
  }
  return null;
}

function mk(host, port, username, password, type) {
  return {
    host: host.trim(),
    port: String(port).trim(),
    username: (username || "").trim(),
    password: (password || "").trim(),
    proxy_type: type,
  };
}

export function parseLine(raw) {
  let line = raw.trim();
  if (!line || line.startsWith("#")) return null;

  const { type, rest } = detectType(line);
  line = rest;

  // Form with '@' : credentials on one side, endpoint on the other.
  if (line.includes("@")) {
    const [left, right] = line.split("@");
    const l = left.split(/[:]/);
    const r = right.split(/[:]/);
    // endpoint is whichever side has a valid port
    if (r.length >= 2 && isPort(r[1]) && looksHost(r[0]))
      return mk(r[0], r[1], l[0] || "", l[1] || "", type);
    if (l.length >= 2 && isPort(l[1]) && looksHost(l[0]))
      return mk(l[0], l[1], r[0] || "", r[1] || "", type);
    return null;
  }

  // No '@' : split on colon / comma / tab / spaces.
  const tokens = line.split(/[\s,:\t]+/).filter(Boolean);
  return fromTokens(tokens, type);
}

export function parseText(text) {
  const parsed = [];
  const failed = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const p = parseLine(raw);
    if (p) parsed.push({ ...p, raw: raw.trim() });
    else failed.push(raw.trim());
  }
  return { parsed, failed };
}
