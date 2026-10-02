// The admin sign-in token and API calls, shared by /admin and /trackside (apps/web/README.md#admin).
// Sign-in is with GitHub through the server, which returns a bearer token in the URL fragment of
// /admin; it's kept in localStorage.

import React from "react";
import { transitApi } from "../config.ts";

const TOKEN_KEY = "transitopia:admin-token";

export function loadToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveToken(token: string | undefined): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // The token only lasts this page view then.
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Call the admin API with the token. */
export async function callApi<T>(
  token: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${transitApi}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!res.ok)
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

export function useApi(token: string | undefined) {
  return React.useCallback(
    <T>(path: string, init: RequestInit = {}): Promise<T> =>
      callApi<T>(token, path, init),
    [token],
  );
}
