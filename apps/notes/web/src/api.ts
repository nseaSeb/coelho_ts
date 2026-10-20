export type Role = "admin" | "editor" | "reader";

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  color: string;
}

export class ApiError extends Error {}

/** Where the pages and their threads are served, on this origin. */
export function collabUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;
}

/** JSON in, JSON out, the session in a cookie the page cannot read. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? null : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? `${response.status}`);
  return data as T;
}

/**
 * A GET polled with the ETag of what was last read: `null` when the server
 * answers 304, nothing changed, and no body was sent.
 */
export async function poll<T>(path: string, etag: { current: string | null }): Promise<T | null> {
  const response = await fetch(path, { headers: etag.current === null ? {} : { "if-none-match": etag.current }, cache: "no-store", credentials: "same-origin" });
  if (response.status === 304) return null;
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? `${response.status}`);
  etag.current = response.headers.get("etag");
  return data;
}

export async function currentUser(): Promise<Me | null> {
  try {
    return await api<Me>("/api/me");
  } catch {
    return null;
  }
}
