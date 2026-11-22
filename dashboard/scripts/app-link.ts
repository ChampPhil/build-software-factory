/**
 * Prints the link that registers the dashboard's GitHub App, filled in.
 *
 *   npx tsx scripts/app-link.ts https://factory.example.com [organization]
 */
import { appRegistrationLink } from "../lib/github-app";

const [origin, organization] = process.argv.slice(2);
if (origin === undefined) {
  console.error("Usage: npx tsx scripts/app-link.ts https://your-dashboard-address [organization]");
  process.exit(1);
}
console.log(appRegistrationLink(origin, organization));
