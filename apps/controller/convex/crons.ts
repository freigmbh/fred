import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("fail stale jobs", { minutes: 1 }, internal.stale.failStale, {});

crons.interval("prune diagnostics", { minutes: 1 }, internal.diagnostics.prune, {});

crons.interval("check project tokens", { hours: 6 }, internal.projectTokens.checkAll, {});

export default crons;
