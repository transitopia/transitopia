// Talking to the admin API (apps/server/README.md#admin-api-and-sign-in) with react-query. Every
// response is parsed with its schema from @transitopia/shared/admin-api.ts, the same ones the
// server types its responses with.

import React from "react";
import * as z from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  authMe,
  correctionsResponse,
  errorResponse,
  okResponse,
  previewResponse,
  statusResponse,
} from "@transitopia/shared/admin-api.ts";
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

/** A request to the server with the admin's token, its response parsed with `schema`. */
export type Call = <T>(
  path: string,
  schema: z.ZodType<T>,
  init?: { method?: string; body?: unknown },
) => Promise<T>;

export function makeCall(token: string | undefined): Call {
  return async (path, schema, init = {}) => {
    const res = await fetch(`${transitApi}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body !== undefined ?
          { "Content-Type": "application/json" }
        : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok)
      throw new ApiError(
        res.status,
        errorResponse.safeParse(body).data?.error ?? `HTTP ${res.status}`,
      );
    return schema.parse(body);
  };
}

export const CallContext = React.createContext<Call>(makeCall(undefined));

const ADMIN = ["admin"] as const;
const CORRECTIONS = [...ADMIN, "corrections"] as const;

/** The signed-in user, if an admin: null if not signed in (or not an admin), undefined while asking. */
export function useAdmin(token: string | undefined) {
  const call = React.useContext(CallContext);
  const me = useQuery({
    queryKey: [...ADMIN, "me", token],
    queryFn: () => call("auth/me", authMe),
    enabled: Boolean(transitApi),
    retry: false,
  });
  if (me.isPending) return undefined;
  const user = me.data?.user;
  return user?.role === "admin" ? user : null;
}

export function useSignOut(onSignedOut: () => void) {
  const call = React.useContext(CallContext);
  const queryClient = useQueryClient();
  return () => {
    void call("auth/logout", okResponse, { method: "POST" }).catch(() => {});
    queryClient.removeQueries({ queryKey: ADMIN });
    onSignedOut();
  };
}

export function useCorrections() {
  const call = React.useContext(CallContext);
  return useQuery({
    queryKey: CORRECTIONS,
    queryFn: () => call("admin/api/corrections", correctionsResponse),
    retry: false,
  });
}

/** The server's status, refreshed every 30 s. */
export function useStatus() {
  const call = React.useContext(CallContext);
  return useQuery({
    queryKey: [...ADMIN, "status"],
    queryFn: () => call("admin/api/status", statusResponse),
    refetchInterval: 30_000,
    retry: false,
  });
}

/** What a write answers: previews for a preview, else just ok. */
const writeResponse = z.union([previewResponse, okResponse]);

/**
 * Writes to corrections (edit, create, preview, confirm, …), reloading the review queue after each
 * one that succeeds. One per card, so a card has one busy state and one error.
 */
export function useWrite() {
  const call = React.useContext(CallContext);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (w: {
      path: string;
      method?: "POST" | "PUT";
      body?: unknown;
    }) =>
      call(w.path, writeResponse, { method: w.method ?? "POST", body: w.body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CORRECTIONS }),
  });
}
