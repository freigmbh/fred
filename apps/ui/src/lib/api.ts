import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../../controller/convex/_generated/api";

export { api };
export type Overview = FunctionReturnType<typeof api.admin.overview>;
export type Failures = FunctionReturnType<typeof api.admin.failures>;
export type Queue = FunctionReturnType<typeof api.admin.queue>;
export type Reviews = FunctionReturnType<typeof api.admin.reviews>;
export type ReviewStats = FunctionReturnType<typeof api.admin.reviewStats>;
export type Review = FunctionReturnType<typeof api.admin.review>;
export type Spend = FunctionReturnType<typeof api.admin.spend>;
export type Projects = FunctionReturnType<typeof api.admin.projects>;
export type Provider = Overview["outcomes"][number]["provider"];
export type FailureKind = Failures["rows"][number]["kind"];
export type JobStatus = Reviews["rows"][number]["status"];
export type FinishedStatus = NonNullable<FunctionArgs<typeof api.admin.reviews>["statuses"]>[number];
export type Severity = NonNullable<Review>["findings"][number]["severity"];
export type StageModels = FunctionArgs<typeof api.admin.savePipeline>["stageModels"];
export type ExportManifest = FunctionReturnType<typeof api.admin.exportManifest>;
export type ExportTable = ExportManifest["tables"][number];
export type ExportRow = FunctionReturnType<typeof api.admin.exportPage>["rows"][number];
export type TranscriptId = FunctionArgs<typeof api.admin.downloadTranscript>["transcriptId"];

export const providers = ["fred", "claude", "codex"] as const satisfies readonly Provider[];
export const providerLabel: Record<Provider, string> = { fred: "FRED", claude: "Claude", codex: "Codex" };
