/**
 * Thin typed client for the ClipSync Worker API.
 *
 * Shared by the desktop agent and the web UI so the two cannot drift. Uses
 * nothing but `fetch` and `URL`, so it runs in Node and the browser alike.
 */

import type {
  ApiError,
  BlobUsageResponse,
  Clip,
  CreateBlobRequest,
  CreateBlobResponse,
  CreateClipRequest,
  CreateClipResponse,
  Credentials,
  Device,
  ListClipsResponse,
  PairCodeResponse,
  Platform,
  ClaimInviteRequest,
  ClaimVaultAuthRequest,
  ClaimVaultAuthResponse,
  PutVaultKeyRequest,
  ClaimInviteResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  ReencryptClipsRequest,
  ReencryptClipsResponse,
  ReencryptItem,
  RotateVaultRequest,
  RotateVaultResponse,
  SealedVaultKeyResponse,
  SetDeviceKeyRequest,
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
   * @param fetchImpl Replacement for the global fetch. The desktop app passes
   *   Tauri's, which issues the request from Rust -- its webview origin is
   *   tauri://localhost, so the browser fetch would be a cross-origin call to
   *   an API that intentionally sends no CORS headers.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private url(path: string): string {
    return this.baseUrl ? new URL(path, this.baseUrl).toString() : path;
  }

  private async send(
    path: string,
    init: RequestInit,
    contentType = "application/json",
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("content-type", contentType);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);

    const res = await this.fetchImpl(this.url(path), { ...init, headers });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      throw new ApiRequestError(
        res.status,
        body?.error ?? "error",
        body?.message ?? `${res.status} ${res.statusText}`,
      );
    }
    return res;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await (await this.send(path, init)).json()) as T;
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

  /** Write the wrapped vault key: the first wrap, or a passphrase change. */
  putVaultKey(body: PutVaultKeyRequest): Promise<{ ok: boolean }> {
    return this.request("/api/vault/key", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  /** Register the passphrase proof on an account that predates it. */
  claimVaultAuth(authHash: string): Promise<ClaimVaultAuthResponse> {
    return this.request("/api/vault/auth", {
      method: "POST",
      body: JSON.stringify({ authHash } satisfies ClaimVaultAuthRequest),
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

  /**
   * Revoke the device this client is signed in as. Resolves once the token
   * no longer works, including when it already did not (a 401), so logging
   * out twice or after a revoke from elsewhere is not an error.
   */
  async revokeSelf(): Promise<void> {
    try {
      await this.request("/api/devices/me", { method: "DELETE" });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) return;
      throw err;
    }
  }

  createClip(body: CreateClipRequest): Promise<CreateClipResponse> {
    return this.request("/api/clips", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * @param options.epochBelow Only clips still under a vault key older than
   *   this epoch: what is left to re-encrypt after a re-key.
   */
  listClips(
    limit = 50,
    before?: string | number,
    options: { epochBelow?: number } = {},
  ): Promise<ListClipsResponse> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined && before !== "") qs.set("before", String(before));
    if (options.epochBelow !== undefined) {
      qs.set("epochBelow", String(options.epochBelow));
    }
    return this.request(`/api/clips?${qs}`);
  }

  /** Move clips to the current vault key; see the reencrypt route. */
  reencryptClips(items: ReencryptItem[]): Promise<ReencryptClipsResponse> {
    return this.request("/api/clips/reencrypt", {
      method: "POST",
      body: JSON.stringify({ items } satisfies ReencryptClipsRequest),
    });
  }

  /** Register this device's long-term public key, for re-keys to seal to. */
  setDeviceKey(publicKey: string): Promise<{ ok: boolean }> {
    return this.request("/api/devices/me/key", {
      method: "PUT",
      body: JSON.stringify({ publicKey } satisfies SetDeviceKeyRequest),
    });
  }

  /** This device's sealed copy of the current vault key, if one was made. */
  sealedVaultKey(): Promise<SealedVaultKeyResponse> {
    return this.request("/api/vault/sealed");
  }

  rotateVault(body: RotateVaultRequest): Promise<RotateVaultResponse> {
    return this.request("/api/vault/rotate", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Every pinned clip, however old; see the list route. */
  listPinned(): Promise<ListClipsResponse> {
    return this.request("/api/clips?pinned=1");
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

  /* ------------------------------ blobs ------------------------------ */

  /** Reserve room for an encrypted image or file; see /api/blobs. */
  createBlob(body: CreateBlobRequest): Promise<CreateBlobResponse> {
    return this.request("/api/blobs", { method: "POST", body: JSON.stringify(body) });
  }

  async putBlobChunk(id: string, index: number, sealed: Uint8Array): Promise<void> {
    await this.send(
      `/api/blobs/${encodeURIComponent(id)}/${index}`,
      { method: "PUT", body: new Uint8Array(sealed) },
      "application/octet-stream",
    );
  }

  async getBlobChunk(id: string, index: number): Promise<Uint8Array> {
    const res = await this.send(`/api/blobs/${encodeURIComponent(id)}/${index}`, {});
    return new Uint8Array(await res.arrayBuffer());
  }

  deleteBlob(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/blobs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** This month's R2 use against the Worker's free-tier budget. */
  blobUsage(): Promise<BlobUsageResponse> {
    return this.request("/api/blobs/usage");
  }
}
