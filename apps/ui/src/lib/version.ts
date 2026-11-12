import { useEffect, useState } from "react";

let request: Promise<string | null> | undefined;

// The deployed FRED version from the version.json that deployment writes beside the admin UI, read once per page load.
// Resolves to null in local development, where nginx's fallback answers with index.html instead of the file.
export function fredVersion() {
  request ??= fetch("/version.json")
    .then((response) => response.json())
    .then((body: { version?: unknown }) => typeof body.version === "string" ? body.version : null)
    .catch(() => null);
  return request;
}

// The deployed FRED version for rendering. Null until it loads and when no deployment stamped the UI.
export function useFredVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void fredVersion().then((loaded) => { if (mounted) setVersion(loaded); });
    return () => { mounted = false; };
  }, []);
  return version;
}
