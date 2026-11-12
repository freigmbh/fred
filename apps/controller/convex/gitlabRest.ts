import { gitlabApiBase } from "./gitlabConfig";

// GitLab answers worth retrying later: request timeout, rate limit, and server errors.
export function retryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

// The waits before each retry of a GitLab call, in order. Comment delivery uses all four, command verification the first three.
export const gitlabRetryDelaysMs = [5_000, 30_000, 120_000, 300_000] as const;

type RestRequest = { method?: "GET" | "POST" | "PUT"; json?: unknown; form?: FormData };

// Sends REST requests to GITLAB_URL as one project access token, with a ten-second timeout each. Redirects are errors, so
// the PRIVATE-TOKEN header never reaches another host. Null without a usable GITLAB_URL.
export function gitlabRest(token: string, fetcher: typeof fetch = fetch) {
  const api = gitlabApiBase();
  if (api === null) return null;
  return (path: string, { method = "GET", json, form }: RestRequest = {}) => fetcher(`${api}/${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "PRIVATE-TOKEN": token, ...(json === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : form ? { body: form } : {}),
  });
}

export type GitLabRest = NonNullable<ReturnType<typeof gitlabRest>>;
