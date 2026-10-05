// JWT utilities (HS256) using Node.js built-in crypto — zero extra deps.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET || "";
  if (s.length >= 32) return s;
  // Fallback: derive from a fixed seed + DEV warning.
  return "sisos-dev-jwt-secret-change-in-production";
})();

const ACCESS_TTL_MS = 15 * 60_000; // 15 minutes
const REFRESH_TTL_MS = 7 * 86_400_000; // 7 days

interface JwtHeader { alg: string; typ: string }
interface JwtPayload { sub: string; email: string; iat: number; exp: number }

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function signHmac(message: string): string {
  return createHmac("sha256", JWT_SECRET).update(message).digest("base64url");
}

/** Create a JWT token. */
export function signToken(payload: Omit<JwtPayload, "iat" | "exp">, ttlMs = ACCESS_TTL_MS): string {
  const now = Date.now();
  const header: JwtHeader = { alg: "HS256", typ: "JWT" };
  const body: JwtPayload = {
    ...payload,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
  };
  const message = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
  return `${message}.${signHmac(message)}`;
}

/** Verify a JWT token. Returns payload or null if invalid/expired. */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    // Verify signature
    const expected = signHmac(`${headerB64}.${payloadB64}`);
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(sigB64, "utf8");
    if (expectedBuf.length !== actualBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, actualBuf)) return null;
    // Decode payload
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as JwtPayload;
    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Generate a random refresh token string. */
export function generateRefreshToken(): string {
  return randomBytes(64).toString("hex");
}

export { ACCESS_TTL_MS, REFRESH_TTL_MS, JWT_SECRET };
