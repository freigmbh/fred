import { useSyncExternalStore } from "react";

const storageKey = "fred.admin-secret";
const rejectedKey = "fred.admin-secret-rejected";
const listeners = new Set<() => void>();

function read() {
  return localStorage.getItem(storageKey);
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

// Clears the stored secret after the controller rejected it, so the login form returns and says why.
export function rejectSecret() {
  sessionStorage.setItem(rejectedKey, "1");
  localStorage.removeItem(storageKey);
  notify();
}

// Whether the last stored secret was rejected, until the next one is stored.
export function secretRejected() {
  return sessionStorage.getItem(rejectedKey) === "1";
}

// The admin secret stored once per browser. Admin calls read it through lib/admin.ts.
export function useAdminSecret() {
  const secret = useSyncExternalStore(subscribe, read, () => null);
  return {
    secret,
    setSecret(value: string) {
      sessionStorage.removeItem(rejectedKey);
      localStorage.setItem(storageKey, value);
      notify();
    },
    clearSecret() {
      localStorage.removeItem(storageKey);
      notify();
    },
  };
}
