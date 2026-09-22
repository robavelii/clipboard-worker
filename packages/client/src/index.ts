/**
 * Thin typed client for the ClipSync Worker API.
 *
 * Shared by the desktop agent and the web UI so the two cannot drift. Uses
 * nothing but `fetch` and `URL`, so it runs in Node and the browser alike.
 */

import type {
  ApiError,
  Clip,
  CreateClipRequest,
  CreateClipResponse,
  Credentials,
  Device,
  ListClipsResponse,
  PairCodeResponse,
  Platform,
  ClaimInviteRequest,
  ClaimInviteResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  TicketResponse,
  VaultKeyResponse,
  WhoAmI,
} from "@clipsync/protocol";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  /**
   * @param baseUrl Absolute Worker URL, or "" when the caller is served from
   *   the Worker's own origin (the web UI).
   * @param token Device bearer token. Omitted for the pairing calls.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private url(path: string): string {
    return this.baseUrl ? new URL(path, this.baseUrl).toString() : path;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);

    const res = await fetch(this.url(path), { ...init, headers });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      throw new ApiRequestError(
        res.status,
        body?.error ?? "error",
        body?.message ?? `${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  }

  bootstrap(
    adminSecret: string,
    deviceName: string,
    platform: Platform,
  ): Promise<Credentials> {
    return this.request("/api/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({ adminSecret, deviceName, platform }),
    });
  }

  pair(
    code: string,
    deviceName: string,
    platform: Platform,
  ): Promise<Credentials> {
    return this.request("/api/devices/pair", {
      method: "POST",
      body: JSON.stringify({ code, deviceName, platform }),
    });
  }

  me(): Promise<WhoAmI> {
    return this.request("/api/auth/me");
  }

  vaultKey(): Promise<VaultKeyResponse> {
    return this.request("/api/vault/key");
  }

  /** Write the wrapped vault key: migration, or completing a passphrase change. */
  putVaultKey(wrappedVaultKey: string): Promise<{ ok: boolean }> {
    return this.request("/api/vault/key", {
      method: "PUT",
      body: JSON.stringify({ wrappedVaultKey }),
    });
  }

  pairCode(): Promise<PairCodeResponse> {
    return this.request("/api/devices/pair-code", { method: "POST" });
  }

  devices(): Promise<{ devices: Device[] }> {
    return this.request("/api/devices");
  }

  revokeDevice(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  createClip(body: CreateClipRequest): Promise<CreateClipResponse> {
    return this.request("/api/clips", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  listClips(limit = 50, before?: number): Promise<ListClipsResponse> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set("before", String(before));
    return this.request(`/api/clips?${qs}`);
  }

  getClip(id: string): Promise<Clip> {
    return this.request(`/api/clips/${encodeURIComponent(id)}`);
  }

  deleteClip(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/clips/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  createInvite(body: CreateInviteRequest): Promise<CreateInviteResponse> {
    return this.request("/api/invites", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  claimInvite(
    id: string,
    body: ClaimInviteRequest,
  ): Promise<ClaimInviteResponse> {
    return this.request(`/api/invites/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  syncTicket(): Promise<TicketResponse> {
    return this.request("/api/sync/ticket", { method: "POST" });
  }

  /** ws:// or wss:// URL carrying a single-use ticket. */
  async syncUrl(): Promise<string> {
    const { ticket } = await this.syncTicket();
    const url = new URL(
      "/api/sync/ws",
      this.baseUrl || globalThis.location?.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    return url.toString();
  }

  pinClip(id: string, pinned: boolean): Promise<{ ok: boolean; pinned: boolean }> {
    return this.request(`/api/clips/${encodeURIComponent(id)}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned }),
    });
  }
}
