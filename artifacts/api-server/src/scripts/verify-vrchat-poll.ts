import { pollGroupInstances, getCachedInstances } from "../lib/vrchatInstances";
import { vrchatCredsConfigured } from "../lib/vrchatClient";

async function main() {
  console.log("creds configured:", vrchatCredsConfigured());
  const count = await pollGroupInstances();
  console.log("polled open instances:", count);
  const cached = await getCachedInstances();
  console.log("cached rows:", cached.length);
  for (const c of cached) {
    console.log(
      `- ${c.worldName} #${c.instanceShortId} [${c.accessType}] users=${c.userCount}${c.capacity ? "/" + c.capacity : ""} region=${c.region ?? "?"}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("verify failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
