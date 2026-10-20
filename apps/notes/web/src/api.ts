export type Role = "admin" | "editor" | "reader";

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  color: string;
}

export class ApiError extends Error {}

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

export async function currentUser(): Promise<Me | null> {
  try {
    return await api<Me>("/api/me");
  } catch {
    return null;
  }
}
