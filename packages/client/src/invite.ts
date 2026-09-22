/**
 * Client half of scan-to-join.
 *
 * Shared so the device that shows the QR and the device that scans it agree on
 * what the QR contains and how the payload is sealed.
 */

import {
  generateInviteSecret,
  inviteProof,
  openInvite,
  sealInvite,
} from "@clipsync/crypto";
import type {
  ClaimInviteResponse,
  CreateInviteResponse,
  Credentials,
  Platform,
} from "@clipsync/protocol";
import type { ApiClient } from "./index";

/**
 * The secret rides in the URL fragment, which browsers never send to the
 * server. So even though scanning opens a page hosted by the Worker, the
 * Worker never sees the secret that opens the payload.
 */
export function buildInviteUrl(
  baseUrl: string,
  inviteId: string,
  secret: string,
): string {
  const url = new URL("/join", baseUrl);
  url.hash = `${inviteId}.${secret}`;
  return url.toString();
}

export function parseInviteUrl(
  input: string,
): { inviteId: string; secret: string } | null {
  try {
    const hash = new URL(input.trim()).hash.replace(/^#/, "");
    const dot = hash.indexOf(".");
    if (dot < 1) return null;
    return { inviteId: hash.slice(0, dot), secret: hash.slice(dot + 1) };
  } catch {
    return null;
  }
}

export interface Invite {
  inviteId: string;
  secret: string;
  url: string;
  expiresAt: number;
}

/** Set-up device: seal the vault key and publish it for one scan. */
export async function createInvite(
  api: ApiClient,
  baseUrl: string,
  vaultKey: string,
): Promise<Invite> {
  const secret = generateInviteSecret();

  const { inviteId, expiresAt }: CreateInviteResponse = await api.createInvite({
    sealedVaultKey: await sealInvite(secret, vaultKey),
    proofHash: await inviteProof(secret),
  });

  return {
    inviteId,
    secret,
    url: buildInviteUrl(baseUrl, inviteId, secret),
    expiresAt,
  };
}

/** Scanning device: redeem the invite and open the vault key. */
export async function claimInvite(
  api: ApiClient,
  inviteId: string,
  secret: string,
  deviceName: string,
  platform: Platform,
): Promise<{ credentials: Credentials; vaultKey: string }> {
  const result: ClaimInviteResponse = await api.claimInvite(inviteId, {
    proof: await inviteProof(secret),
    deviceName,
    platform,
  });

  return {
    credentials: result.credentials,
    vaultKey: await openInvite(secret, result.sealedVaultKey),
  };
}
