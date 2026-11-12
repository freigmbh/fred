import { ConvexError } from "convex/values";

const prefix = "v1";

function bytesOf(base64: string) {
  const binary = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64Of(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Imports the AES-256-GCM key from FRED_TOKEN_KEY, 32 bytes in base64 as `openssl rand -base64 32` prints.
// Throws a `token_key_invalid` ConvexError otherwise.
async function vaultKey() {
  const raw = (() => {
    try { return bytesOf(process.env.FRED_TOKEN_KEY?.trim() ?? ""); } catch { return undefined; }
  })();
  if (raw?.length !== 32) throw new ConvexError({ code: "token_key_invalid", message: "Set FRED_TOKEN_KEY on the controller to 32 random bytes in base64." });
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Seals a project access token for storage. The GitLab project ID is authenticated data, so a sealed token opens only for its own project.
export async function sealToken(token: string, gitlabProjectId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(gitlabProjectId) },
    await vaultKey(), new TextEncoder().encode(token));
  return `${prefix}.${base64Of(iv)}.${base64Of(new Uint8Array(sealed))}`;
}

// Opens a token sealed by sealToken with the same `gitlabProjectId`. Throws when the value is malformed, the key changed, or
// the project ID differs.
export async function openToken(sealed: string, gitlabProjectId: string) {
  const [version, iv, data] = sealed.split(".");
  if (version !== prefix || !iv || !data) throw new Error("unreadable sealed token");
  const token = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesOf(iv), additionalData: new TextEncoder().encode(gitlabProjectId) },
    await vaultKey(), bytesOf(data));
  return new TextDecoder().decode(token);
}
