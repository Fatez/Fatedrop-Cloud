import { env } from "./config/env.mjs";
import { syncAsmodeeRrp } from "./rrp/asmodee-authority.mjs";

try {
  const result = await syncAsmodeeRrp({ databaseUrl: env.databaseUrl });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
