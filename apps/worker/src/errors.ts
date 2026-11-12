import { Data } from "effect";
import type { DiagnosticFailure } from "@fred/contracts";

export class ControllerError extends Data.TaggedError("ControllerError")<{ message: string; cause?: unknown; diagnostic?: DiagnosticFailure }> {}
export class GitLabError extends Data.TaggedError("GitLabError")<{ message: string; status?: number; retryable?: boolean; body?: string; cause?: unknown; diagnostic?: DiagnosticFailure }> {}
export class CloneError extends Data.TaggedError("CloneError")<{ message: string; stderr?: string; cause?: unknown }> {}
export class ProviderError extends Data.TaggedError("ProviderError")<{ message: string; retryable?: boolean; output?: string; cause?: unknown; diagnostic?: DiagnosticFailure }> {}
export class ParseError extends Data.TaggedError("ParseError")<{ message: string; cause?: unknown; diagnostic?: DiagnosticFailure }> {}
export class SandboxError extends Data.TaggedError("SandboxError")<{ message: string; cause?: unknown }> {}
export class ConfigError extends Data.TaggedError("ConfigError")<{ message: string; cause?: unknown }> {}
export class Timeout extends Data.TaggedError("Timeout")<{ message: string }> {}
export class LabelMissing extends Data.TaggedError("LabelMissing")<{ message: string }> {}
export class TranscriptError extends Data.TaggedError("TranscriptError")<{ message: string; cause?: unknown }> {}
export class DiagnosticSlotBusy extends Data.TaggedError("DiagnosticSlotBusy")<{}> {}

export type WorkerError = ControllerError | GitLabError | CloneError | ProviderError | ParseError | SandboxError | ConfigError | Timeout | LabelMissing;
