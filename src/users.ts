// User management for SiSos JWT auth: register, login, refresh, logout.
// Users persisted to data/users.json (in-memory map + file).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { generateRefreshToken, signToken, verifyToken, REFRESH_TTL_MS } from "./jwt.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string; // SHA-256 of password (same approach as existing auth.ts)
  createdAt: string;
}

interface StoredRefreshToken {
  tokenHash: string;
  userId: string;
  expiresAt: number; // ms
}

interface UsersData {
  users: User[];
  refreshTokens: StoredRefreshToken[];
}

const USERS_PATH = "data/users.json";

// In-memory store
let users: User[] = [];
let refreshTokens: StoredRefreshToken[] = [];

function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function loadUsers(): void {
  try {
    if (!existsSync(USERS_PATH)) { users = []; return; }
    const raw = readFileSync(USERS_PATH, "utf8");
    const data: UsersData = JSON.parse(raw);
    users = Array.isArray(data.users) ? data.users : [];
    refreshTokens = Array.isArray(data.refreshTokens) ? data.refreshTokens : [];
    // Prune expired refresh tokens
    const now = Date.now();
    refreshTokens = refreshTokens.filter((t) => t.expiresAt > now);
  } catch {
    users = [];
    refreshTokens = [];
  }
}

function saveUsers(): void {
  try {
    mkdirSync(dirname(USERS_PATH), { recursive: true });
    const data: UsersData = { users, refreshTokens };
    writeFileSync(USERS_PATH, JSON.stringify(data, null, 2));
  } catch { /* ignore persistence errors */ }
}

function findUserByEmail(email: string): User | undefined {
  return users.find((u) => u.email.toLowerCase() === email.toLowerCase().trim());
}

function findUserById(id: string): User | undefined {
  return users.find((u) => u.id === id);
}

function pruneExpiredRefreshTokens(): void {
  const now = Date.now();
  refreshTokens = refreshTokens.filter((t) => t.expiresAt > now);
}

// Initialize on module load
loadUsers();

export interface RegisterResult {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  user: User;
  accessToken: string;
  refreshToken: string;
}

/** Register a new user with email + password. Returns tokens. */
export function register(email: string, password: string): RegisterResult | null {
  const trimmed = email.toLowerCase().trim();
  if (!trimmed || !password || password.length < 6) return null;
  if (findUserByEmail(trimmed)) return null; // already exists

  const now = new Date().toISOString();
  const user: User = {
    id: `u_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    email: trimmed,
    passwordHash: hashPassword(password),
    createdAt: now,
  };
  users.push(user);

  const refreshToken = generateRefreshToken();
  refreshTokens.push({
    tokenHash: createHash("sha256").update(refreshToken).digest("hex"),
    userId: user.id,
    expiresAt: Date.now() + REFRESH_TTL_MS,
  });

  const accessToken = signToken({ sub: user.id, email: user.email });
  saveUsers();
  return { user, accessToken, refreshToken };
}

/** Login with email + password. Returns tokens. */
export function login(email: string, password: string): LoginResult | null {
  const user = findUserByEmail(email);
  if (!user) return null;
  const inputHash = hashPassword(password);
  try {
    timingSafeEqual(Buffer.from(inputHash), Buffer.from(user.passwordHash));
  } catch {
    return null;
  }
  if (inputHash !== user.passwordHash) return null;

  const refreshToken = generateRefreshToken();
  pruneExpiredRefreshTokens();
  refreshTokens.push({
    tokenHash: createHash("sha256").update(refreshToken).digest("hex"),
    userId: user.id,
    expiresAt: Date.now() + REFRESH_TTL_MS,
  });

  const accessToken = signToken({ sub: user.id, email: user.email });
  saveUsers();
  return { user, accessToken, refreshToken };
}

/** Verify an access token. Returns payload (sub, email) or null. */
export function verifyAccessToken(token: string): { sub: string; email: string } | null {
  const payload = verifyToken(token);
  if (!payload) return null;
  if (!findUserById(payload.sub)) return null; // user must exist
  return { sub: payload.sub, email: payload.email };
}

/** Exchange a refresh token for a new access token. */
export function refreshAccessToken(refreshToken: string): string | null {
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  pruneExpiredRefreshTokens();
  const stored = refreshTokens.find((t) => t.tokenHash === tokenHash);
  if (!stored) return null;
  const user = findUserById(stored.userId);
  if (!user) return null;
  const accessToken = signToken({ sub: user.id, email: user.email });
  saveUsers();
  return accessToken;
}

/** Logout: invalidate a refresh token. */
export function logout(refreshToken: string): boolean {
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  const idx = refreshTokens.findIndex((t) => t.tokenHash === tokenHash);
  if (idx < 0) return false;
  refreshTokens.splice(idx, 1);
  saveUsers();
  return true;
}

/** List all users (for admin/debug). */
export function listUsers(): User[] {
  return users.map((u) => ({ ...u, passwordHash: "[redacted]" }));
}
