/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as adminAuth from "../adminAuth.js";
import type * as adminModels from "../adminModels.js";
import type * as adminProjects from "../adminProjects.js";
import type * as botAvatar from "../botAvatar.js";
import type * as openrouterCatalog from "../openrouterCatalog.js";
import type * as crons from "../crons.js";
import type * as dataExport from "../dataExport.js";
import type * as diagnostics from "../diagnostics.js";
import type * as diagnosticCapture from "../diagnosticCapture.js";
import type * as enqueue from "../enqueue.js";
import type * as gitlab from "../gitlab.js";
import type * as gitlabApi from "../gitlabApi.js";
import type * as gitlabConfig from "../gitlabConfig.js";
import type * as findingLifecycle from "../findingLifecycle.js";
import type * as findingCommands from "../findingCommands.js";
import type * as findingCommandWebhook from "../findingCommandWebhook.js";
import type * as findingCommandRequests from "../findingCommandRequests.js";
import type * as mrWork from "../mrWork.js";
import type * as http from "../http.js";
import type * as jobFindings from "../jobFindings.js";
import type * as jobLifecycle from "../jobLifecycle.js";
import type * as jobQueue from "../jobQueue.js";
import type * as jobUsage from "../jobUsage.js";
import type * as jobs from "../jobs.js";
import type * as migrations from "../migrations.js";
import type * as month from "../month.js";
import type * as mrNotes from "../mrNotes.js";
import type * as policy from "../policy.js";
import type * as policyInput from "../policyInput.js";
import type * as projectTokens from "../projectTokens.js";
import type * as reviewFailures from "../reviewFailures.js";
import type * as settings from "../settings.js";
import type * as stale from "../stale.js";
import type * as tokenVault from "../tokenVault.js";
import type * as transcripts from "../transcripts.js";
import type * as workerAuth from "../workerAuth.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  adminAuth: typeof adminAuth;
  adminModels: typeof adminModels;
  adminProjects: typeof adminProjects;
  botAvatar: typeof botAvatar;
  openrouterCatalog: typeof openrouterCatalog;
  crons: typeof crons;
  dataExport: typeof dataExport;
  diagnostics: typeof diagnostics;
  diagnosticCapture: typeof diagnosticCapture;
  enqueue: typeof enqueue;
  gitlab: typeof gitlab;
  gitlabApi: typeof gitlabApi;
  gitlabConfig: typeof gitlabConfig;
  findingLifecycle: typeof findingLifecycle;
  findingCommands: typeof findingCommands;
  findingCommandWebhook: typeof findingCommandWebhook;
  findingCommandRequests: typeof findingCommandRequests;
  mrWork: typeof mrWork;
  http: typeof http;
  jobFindings: typeof jobFindings;
  jobLifecycle: typeof jobLifecycle;
  jobQueue: typeof jobQueue;
  jobUsage: typeof jobUsage;
  jobs: typeof jobs;
  migrations: typeof migrations;
  month: typeof month;
  mrNotes: typeof mrNotes;
  policy: typeof policy;
  policyInput: typeof policyInput;
  projectTokens: typeof projectTokens;
  reviewFailures: typeof reviewFailures;
  settings: typeof settings;
  stale: typeof stale;
  tokenVault: typeof tokenVault;
  transcripts: typeof transcripts;
  workerAuth: typeof workerAuth;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
