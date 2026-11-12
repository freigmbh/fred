// The controller's GITLAB_URL without its trailing slash, such as https://gitlab.example, for MR links. Null when it is
// unset or not a plain http(s) URL: credentials, a query, or a fragment in it are refused, so they never reach a link or a request.
export function gitlabWebUrl() {
  const base = process.env.GITLAB_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// The controller's GitLab REST base, such as https://gitlab.example/api/v4. Null when gitlabWebUrl is.
export function gitlabApiBase() {
  const web = gitlabWebUrl();
  return web === null ? null : `${web}/api/v4`;
}

// GitLab user IDs of bots outside FRED that author MRs, such as Renovate, from BOT_USER_IDS_OTHER.
export function otherBotIds() {
  return (process.env.BOT_USER_IDS_OTHER ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}
