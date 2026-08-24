let TOKEN = sessionStorage.getItem("app_token") || "";

export function setToken(t) {
  TOKEN = t || "";
  sessionStorage.setItem("app_token", TOKEN);
}
export function getToken() {
  return TOKEN;
}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { "x-app-token": TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw { unauthorized: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  health: () => fetch("/api/health").then((r) => r.json()),
  bridgeStatus: () => req("GET", "/api/bridge/status"),
  stats: () => req("GET", "/api/proxies/stats"),
  proxies: (status) => req("GET", `/api/proxies?status=${status}`),
  upload: (text, source) => req("POST", "/api/proxies/upload", { text, source }),
  suggest: (count) => req("POST", "/api/proxies/suggest", { count }),
  sync: () => req("POST", "/api/profiles/sync"),
  delProxy: (id) => req("DELETE", `/api/proxies/${id}`),
  delProxiesBatch: (ids) => req("POST", "/api/proxies/delete-batch", { ids }),
  reconcileProxies: () => req("POST", "/api/proxies/reconcile"),
  testProxies: (ids) => req("POST", "/api/proxies/test-batch", { ids }),
  plan: (b) => req("POST", "/api/profiles/plan", b),
  profiles: () => req("GET", "/api/profiles"),
  delProfiles: (ids) => req("POST", "/api/profiles/delete", { ids }),
  reassignProxies: (names, source) =>
    req("POST", "/api/profiles/reassign-proxy", { names, source }),
  proxySources: () => req("GET", "/api/proxies/sources"),
  jobs: () => req("GET", "/api/jobs"),
  exportUrl: () => "/api/export.csv",
};