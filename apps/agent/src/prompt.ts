/** Minimal interactive prompts. No dependency is worth taking for this. */

import { createInterface, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";

/**
 * Lines are buffered rather than read per question.
 *
 * `rl.question()` only captures input that arrives while it is pending, and a
 * piped stdin delivers every line in a single chunk -- so answers 2..n are
 * emitted before the second question is asked, and dropped. Queuing them makes
 * scripted enrolment (`printf ... | clipsync login`) work the same as typing.
 */
const buffered: string[] = [];
const waiting: Array<(line: string) => void> = [];
let reader: Interface | null = null;
let ended = false;

function wire(): void {
  if (reader) return;
  reader = createInterface({ input: stdin });
  reader.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  reader.on("close", () => {
    ended = true;
    // Unblock anything still waiting; the caller validates the empty answer.
    for (const next of waiting.splice(0)) next("");
  });
}

function nextLine(): Promise<string> {
  wire();
  const line = buffered.shift();
  if (line !== undefined) return Promise.resolve(line);
  if (ended) return Promise.resolve("");
  return new Promise((resolve) => waiting.push(resolve));
}

/** Releases stdin so the process can exit. Safe to call when unused. */
export function closePrompts(): void {
  reader?.close();
  reader = null;
}

export async function ask(question: string): Promise<string> {
  stdout.write(question);
  const answer = (await nextLine()).trim();
  if (!stdin.isTTY) stdout.write("\n");
  return answer;
}

/** Reads without echoing. Falls back to a visible prompt when not a TTY. */
export async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) return ask(question);

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === CTRL_D) {
          cleanup();
          resolve(value);
          return;
        }
        if (char === CTRL_C) {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (char === BACKSPACE || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Asks twice and refuses to continue on a mismatch. A mistyped passphrase is
 * unrecoverable: it is the only key to the clipboard history.
 */
export async function askNewPassphrase(): Promise<string> {
  const first = await askSecret("Encryption passphrase: ");
  if (first.length < 8) {
    throw new Error("passphrase must be at least 8 characters");
  }
  const second = await askSecret("Confirm passphrase: ");
  if (first !== second) throw new Error("passphrases do not match");
  return first;
}
