import express from "express";
import { hashPassword, hashToken, newSessionToken, ROLES, verifyPassword, type AccountStore, type Role, type User } from "./accounts.js";

export const COOKIE = "coelho_session";
const SESSION_DAYS = 30;

export interface AuthOptions {
  accounts: AccountStore;
  /** The role of everyone who signs up after the first, who is the admin. */
  defaultRole: Role;
  /** `false` closes sign-up, except for the very first account. */
  signup: boolean;
  /** Mark the cookie Secure: on as soon as the app is served over https. */
  secureCookies: boolean;
  /** Called when someone's role changes, to close their connections so it applies now. */
  onRoleChanged?: (userId: string) => void;
}

export function sessionToken(cookieHeader: string | null | undefined): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=") || null;
  }
  return null;
}

/** The signed-in user for a request's cookies, or `null`. */
export async function userFrom(accounts: AccountStore, cookieHeader: string | null | undefined): Promise<User | null> {
  const token = sessionToken(cookieHeader);
  return token === null ? null : accounts.sessionUser(hashToken(token));
}

/** A stable colour per person, the same in every browser. */
export function colorOf(user: Pick<User, "id">): string {
  const palette = ["#b5442c", "#2d6a9f", "#2d7a3e", "#8a4fb5", "#b5862c", "#2c9fa0", "#a03c6e", "#5c6b2d"];
  let h = 0;
  for (const char of user.id) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return palette[h % palette.length] as string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Not more than this many failed sign-ins per address and per client, in a window. */
const ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

export function authRoutes(options: AuthOptions): express.Router {
  const { accounts } = options;
  const router = express.Router();
  const failures = new Map<string, { count: number; since: number }>();

  // Every request that changes something carries JSON. A form posted from
  // another site cannot, and the cookie is SameSite=Lax besides.
  // Small JSON everywhere; the import parses its own, larger, once the session is checked.
  const json = express.json({ limit: "16kb" });
  router.use((request, response, next) => (request.path === "/api/import" ? next() : json(request, response, next)));
  router.use((request, response, next) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method) && !request.is("application/json")) {
      response.status(415).json({ error: "send JSON" });
      return;
    }
    next();
  });

  const startSession = async (response: express.Response, user: User): Promise<void> => {
    const { token, hash } = newSessionToken();
    const maxAge = SESSION_DAYS * 24 * 3600;
    await accounts.createSession(user.id, hash, new Date(Date.now() + maxAge * 1000));
    response.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${options.secureCookies ? "; Secure" : ""}`,
    );
  };

  const signedIn = async (request: express.Request, response: express.Response): Promise<User | null> => {
    const user = await userFrom(accounts, request.headers.cookie);
    if (user === null) response.status(401).json({ error: "sign in first" });
    return user;
  };

  router.post("/api/signup", async (request, response) => {
    const email = String(request.body?.email ?? "").trim().toLowerCase();
    const name = String(request.body?.name ?? "").trim();
    const password = String(request.body?.password ?? "");
    if (!EMAIL.test(email) || email.length > 254) return void response.status(400).json({ error: "an email address, please" });
    if (name.length < 1 || name.length > 60) return void response.status(400).json({ error: "a name of 1 to 60 characters" });
    if (password.length < 8 || password.length > 200) return void response.status(400).json({ error: "a password of at least 8 characters" });
    if (!options.signup && (await accounts.list()).length > 0) return void response.status(403).json({ error: "sign-up is closed: ask an admin" });
    const created = await accounts.create({ email, name, passwordHash: await hashPassword(password), role: options.defaultRole });
    if (created === "taken") return void response.status(409).json({ error: "an account already uses this address" });
    await startSession(response, created);
    response.status(201).json(created);
  });

  router.post("/api/login", async (request, response) => {
    const email = String(request.body?.email ?? "").trim().toLowerCase();
    const password = String(request.body?.password ?? "");
    const key = `${email}|${request.ip}`;
    const seen = failures.get(key);
    if (seen !== undefined && Date.now() - seen.since < WINDOW_MS && seen.count >= ATTEMPTS) {
      return void response.status(429).json({ error: "too many attempts: try again in a few minutes" });
    }
    const account = await accounts.byEmail(email);
    // The same work whether or not the address exists, so timing tells nothing.
    const ok = await verifyPassword(password, account?.passwordHash ?? (await DUMMY));
    if (account === null || !ok) {
      const fresh = seen === undefined || Date.now() - seen.since >= WINDOW_MS;
      failures.set(key, { count: fresh ? 1 : (seen?.count ?? 0) + 1, since: fresh ? Date.now() : (seen?.since ?? Date.now()) });
      return void response.status(401).json({ error: "wrong email or password" });
    }
    failures.delete(key);
    const user: User = { id: account.id, email: account.email, name: account.name, role: account.role };
    await startSession(response, user);
    response.json(user);
  });

  router.post("/api/logout", async (request, response) => {
    const token = sessionToken(request.headers.cookie);
    if (token !== null) await accounts.deleteSession(hashToken(token));
    response.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    response.status(204).end();
  });

  router.get("/api/me", async (request, response) => {
    const user = await signedIn(request, response);
    if (user !== null) response.json({ ...user, color: colorOf(user) });
  });

  router.get("/api/users", async (request, response) => {
    const user = await signedIn(request, response);
    if (user === null) return;
    if (user.role !== "admin") return void response.status(403).json({ error: "admins only" });
    response.json(await accounts.list());
  });

  router.patch("/api/users/:id", async (request, response) => {
    const user = await signedIn(request, response);
    if (user === null) return;
    if (user.role !== "admin") return void response.status(403).json({ error: "admins only" });
    const role = request.body?.role as Role;
    if (!ROLES.includes(role)) return void response.status(400).json({ error: `a role among ${ROLES.join(", ")}` });
    const everyone = await accounts.list();
    const target = everyone.find((one) => one.id === request.params.id);
    if (target === undefined) return void response.status(404).json({ error: "no such person" });
    if (target.role === "admin" && role !== "admin" && everyone.filter((one) => one.role === "admin").length === 1) {
      return void response.status(409).json({ error: "the last admin stays an admin" });
    }
    const updated = await accounts.setRole(target.id, role);
    options.onRoleChanged?.(target.id);
    response.json(updated);
  });

  return router;
}

// A hash to verify against when the address is unknown.
const DUMMY = hashPassword("not a password anyone has");
