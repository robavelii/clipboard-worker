// The two modules the build supplies from apps/worker (see worker-inputs.mjs).
// Typed here by shape, so this workspace typechecks against Node's types
// without pulling in the Workers runtime types the Worker compiles against.

declare module "clipsync:worker-app" {
  interface ExecutionContextLike {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
    props: Record<string, unknown>;
  }
  export const app: {
    fetch(request: Request, env: object, ctx: ExecutionContextLike): Response | Promise<Response>;
  };
  export function purgeExpired(env: object, now: number): Promise<Record<string, number>>;
  export interface Mailer {
    send(message: { to: string; subject: string; text: string }): Promise<void>;
  }
  export interface MailSocket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    close(): unknown;
  }
  export function mailerFor(
    env: Record<string, string | undefined>,
    connect: ((host: string, port: number) => MailSocket | Promise<MailSocket>) | null,
  ): Mailer | null;
}

declare module "clipsync:worker-inputs" {
  const inputs: {
    vars: Record<string, string | number>;
    limits: Record<string, { limit: number; period: number }>;
    migrations: { name: string; sql: string }[];
  };
  export default inputs;
}
