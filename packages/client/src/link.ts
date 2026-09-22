/**
 * Client half of the device-linking handshake.
 *
 * Shared by both sides so the joining device and the approving device cannot
 * drift in how they build and verify the transcript.
 */

import {
  createLinkKeypair,
  fingerprint,
  openFromDevice,
  sealToDevice,
  type LinkKeypair,
} from "@clipsync/crypto";
import type {
  Credentials,
  LinkClaimResponse,
  LinkRequestResponse,
  LinkStatusResponse,
  Platform,
} from "@clipsync/protocol";

/** Poll interval while waiting for a human to approve. */
const POLL_MS = 2000;

export interface PendingLink {
  keypair: LinkKeypair;
  linkId: string;
  pickupToken: string;
  expiresAt: number;
  /** The URL encoded into the QR. Carries the public key out of band. */
  url: string;
  /** Shown on both devices so a human can confirm they match. */
  fingerprint: string;
}

/**
 * The public key travels inside the URL fragment. A fragment is never sent to
 * the server by a browser, so even when this link is opened in the web UI the
 * key reaches the approving page without the server seeing which key was
 * scanned.
 */
export function buildLinkUrl(baseUrl: string, linkId: string, publicKey: string): string {
  const url = new URL("/link", baseUrl);
  url.hash = `${linkId}.${publicKey}`;
  return url.toString();
}

export function parseLinkUrl(
  input: string,
): { linkId: string; publicKey: string } | null {
  try {
    const hash = new URL(input.trim()).hash.replace(/^#/, "");
    const dot = hash.indexOf(".");
    if (dot < 1) return null;
    return { linkId: hash.slice(0, dot), publicKey: hash.slice(dot + 1) };
  } catch {
    return null;
  }
}

/** Joining device: publish a public key and describe how to approve it. */
export async function beginLink(
  baseUrl: string,
  deviceName: string,
  platform: Platform,
): Promise<PendingLink> {
  const keypair = await createLinkKeypair();

  const res = await fetch(new URL("/api/link/request", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: keypair.publicKey,
      deviceName,
      platform,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `link request failed (${res.status})`);
  }

  const { linkId, pickupToken, expiresAt } =
    (await res.json()) as LinkRequestResponse;

  return {
    keypair,
    linkId,
    pickupToken,
    expiresAt,
    url: buildLinkUrl(baseUrl, linkId, keypair.publicKey),
    fingerprint: await fingerprint(keypair.publicKey),
  };
}

/**
 * Joining device: wait for approval, then open the sealed secret.
 *
 * Returns the credentials *and* the passphrase, which is what makes this
 * worth doing -- nobody types it on this machine.
 */
export async function awaitApproval(
  baseUrl: string,
  pending: PendingLink,
  onTick?: (secondsLeft: number) => void,
): Promise<{ credentials: Credentials; passphrase: string }> {
  for (;;) {
    if (Date.now() > pending.expiresAt) {
      throw new Error("link request expired -- run `clipsync link` again");
    }

    const res = await fetch(
      new URL(`/api/link/${pending.linkId}/claim`, baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pickupToken: pending.pickupToken }),
      },
    );

    if (res.status === 202) {
      onTick?.(Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)));
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `claim failed (${res.status})`);
    }

    const result = (await res.json()) as LinkClaimResponse;
    if (result.status !== "approved") {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    const passphrase = await openFromDevice(
      pending.keypair,
      result.approverPublicKey,
      result.wrappedSecret,
    );

    return { credentials: result.credentials, passphrase };
  }
}

/** Approving device: read back the request so a human can check it. */
export async function inspectLink(
  baseUrl: string,
  token: string,
  linkId: string,
): Promise<LinkStatusResponse> {
  const res = await fetch(new URL(`/api/link/${linkId}`, baseUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `cannot read link request (${res.status})`);
  }
  return (await res.json()) as LinkStatusResponse;
}

/**
 * Approving device: seal the passphrase to the joining device.
 *
 * `expectedPublicKey` is the key that arrived out of band. It is compared
 * against what the server returned, which is what defeats a server that tries
 * to substitute its own key.
 */
export async function approveLink(
  baseUrl: string,
  token: string,
  linkId: string,
  expectedPublicKey: string,
  passphrase: string,
): Promise<{ deviceName: string }> {
  const status = await inspectLink(baseUrl, token, linkId);

  if (status.publicKey !== expectedPublicKey) {
    throw new Error(
      "the key the server returned does not match the one you scanned -- refusing to approve",
    );
  }

  const { envelope, approverPublicKey } = await sealToDevice(
    expectedPublicKey,
    passphrase,
  );

  const res = await fetch(new URL(`/api/link/${linkId}/approve`, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ approverPublicKey, wrappedSecret: envelope }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `approval failed (${res.status})`);
  }

  return (await res.json()) as { deviceName: string };
}
