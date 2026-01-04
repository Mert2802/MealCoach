const ENV_API_URL = import.meta.env.VITE_API_URL || "";

function normalizeBaseUrl(value) {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getBaseUrl() {
  if (typeof localStorage === "undefined") return normalizeBaseUrl(ENV_API_URL);
  return normalizeBaseUrl(localStorage.getItem("mealcoach_api_url") || ENV_API_URL);
}

export async function apiGet(path) {
  const res = await fetch(`${getBaseUrl()}${path}`);
  if (!res.ok) throw new Error("Request failed");
  return res.json();
}

export async function apiPost(path, body) {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("Request failed");
  return res.json();
}

export async function apiUpload(path, formData) {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    body: formData
  });
  if (!res.ok) throw new Error("Request failed");
  return res.json();
}

export function getApiUrl() {
  return getBaseUrl();
}

export function setApiUrl(value) {
  if (typeof localStorage === "undefined") return;
  if (!value) {
    localStorage.removeItem("mealcoach_api_url");
    return;
  }
  localStorage.setItem("mealcoach_api_url", value);
}
