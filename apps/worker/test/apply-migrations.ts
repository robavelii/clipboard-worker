import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Each test file gets isolated storage, so this runs against an empty database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
