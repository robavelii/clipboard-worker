/**
 * A standalone agent updating itself to the newest release (decisions §34).
 *
 * Trust: the releases it looks at are the ones baked in when it was built
 * (__CLIPSYNC_RELEASES__), never an address the server hands out. The server
 * is not trusted with anything readable, and one that could name the next
 * binary would be trusted with every device. A download must match the
 * release's SHA256SUMS, run, and report the version it was fetched as before
 * it replaces anything, and a release only ever moves forward.
 *
 * Only release builds update: a build from a checkout names a commit, not a
 * release, and is updated with git.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { isOlderRelease, parseRelease } from "@clipsync/protocol";
import { sha256Hex } from "@clipsync/crypto";
import { replaceExecutable } from "./self";

/** Where this build looks for releases; CLIPSYNC_RELEASES points at a mirror. */
export function releasesUrl(): string {
  return process.env.CLIPSYNC_RELEASES || __CLIPSYNC_RELEASES__;
}

/** This machine's release target, as the release workflow names them. */
export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : null;
  if (!os || (arch !== "x64" && arch !== "arm64")) return null;
  // No Windows ARM build: the x64 one runs under Windows' emulation.
  return os === "windows" ? "windows-x64" : `${os}-${arch}`;
}

/** The release asset an update downloads: the bare binary, gzipped. */
export const updateAsset = (target: string) => `clipsync-${target}.gz`;

/**
 * The newest release's tag. GitHub answers `releases/latest` with a
 * redirect to its tag, which is read without following it: no API call,
 * so no API rate limit. null when there is no release, or no answer.
 */
export async function latestRelease(
  releases = releasesUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(`${releases}/latest`, { redirect: "manual" });
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(res.headers.get("location") ?? "")?.[1];
  const decoded = tag ? decodeURIComponent(tag) : null;
  return decoded && parseRelease(decoded) ? decoded : null;
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`could not download ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The digest SHA256SUMS lists for `name` ("<hash>  <name>", or " *<name>"). */
export function listedDigest(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return null;
}

export interface InstallReleaseOptions {
  releases?: string;
  target?: string;
  fetchImpl?: typeof fetch;
}

/**
 * A release that downloaded and matched its checksum but does not run on
 * this machine: a binary on a newer Node that needs a newer OS, such as
 * macOS 13.5 for Node 24 (decisions §42).
 */
export class ReleaseWontRunError extends Error {
  constructor(
    readonly tag: string,
    said: string,
  ) {
    super(`the downloaded ${tag} does not run as it should (it said: ${said})`);
    this.name = "ReleaseWontRunError";
  }
}

/**
 * Download `tag`'s binary for this machine, check it, and put it in place
 * of the executable at `path`.
 */
export async function installRelease(
  tag: string,
  path: string,
  opts: InstallReleaseOptions = {},
): Promise<void> {
  const releases = opts.releases ?? releasesUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const target = opts.target ?? releaseTarget();
  if (!target) throw new Error(`no release is built for ${process.platform}-${process.arch}`);

  const asset = updateAsset(target);
  const base = `${releases}/download/${tag}`;
  const [archive, sums] = await Promise.all([
    download(`${base}/${asset}`, fetchImpl),
    download(`${base}/SHA256SUMS`, fetchImpl),
  ]);
  const expected = listedDigest(new TextDecoder().decode(sums), asset);
  if (!expected) throw new Error(`${tag}'s SHA256SUMS lists no ${asset}`);
  const actual = await sha256Hex(archive);
  if (actual !== expected) throw new Error(`${asset} from ${tag} does not match its checksum`);

  const fresh = `${path}.new`;
  writeFileSync(fresh, gunzipSync(archive));
  chmodSync(fresh, 0o755);
  // It must run, and be the release it was fetched as, before it replaces
  // the binary that works.
  const ran = spawnSync(fresh, ["--version"], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  const says = ran.stdout?.trim() ?? "";
  if (says !== `clipsync ${tag}`) {
    rmSync(fresh, { force: true });
    throw new ReleaseWontRunError(tag, says || ran.error?.message || ran.stderr?.trim() || "nothing");
  }
  replaceExecutable(fresh, path);
}

export type UpdateResult =
  | { status: "updated"; from: string; to: string }
  | { status: "current"; latest: string }
  /** The newest release is one this machine already found it cannot run. */
  | { status: "skipped"; latest: string }
  | { status: "not-a-release"; build: string }
  | { status: "unknown" };

/**
 * Update the executable at `path`, which is release `current`, to the
 * newest release if that is newer and not in `skip`.
 */
export async function updateTo(
  current: string,
  path: string,
  opts: InstallReleaseOptions & { skip?: ReadonlySet<string> } = {},
): Promise<UpdateResult> {
  if (!parseRelease(current)) return { status: "not-a-release", build: current };
  const latest = await latestRelease(opts.releases ?? releasesUrl(), opts.fetchImpl ?? fetch);
  if (!latest) return { status: "unknown" };
  if (!isOlderRelease(current, latest)) return { status: "current", latest };
  if (opts.skip?.has(latest)) return { status: "skipped", latest };
  await installRelease(latest, path, opts);
  return { status: "updated", from: current, to: latest };
}
