import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StageId } from "../config/schema.js";

const RUNS_DIR = path.join(os.homedir(), ".jira-acp", "runs");

// ── Event types ───────────────────────────────────────────────────────────

export type PipelineEvent =
  | { type: "STARTED"; ticketKey: string; timestamp: string }
  | { type: "STAGE_STARTED"; stage: StageId; timestamp: string }
  | {
      type: "STAGE_COMPLETED";
      stage: StageId;
      output: unknown;
      timestamp: string;
    }
  | { type: "STAGE_FAILED"; stage: StageId; error: string; timestamp: string }
  | { type: "STAGE_SKIPPED"; stage: StageId; reason: string; timestamp: string }
  | { type: "CLARIFICATION_REQUESTED"; questions: string[]; timestamp: string }
  | { type: "CLARIFICATION_RECEIVED"; answers: string; timestamp: string }
  | { type: "HUMAN_APPROVAL_REQUESTED"; context: unknown; timestamp: string }
  | { type: "HUMAN_APPROVED"; timestamp: string }
  | { type: "HUMAN_REJECTED"; reason: string; timestamp: string }
  | { type: "PIPELINE_COMPLETED"; timestamp: string }
  | { type: "PIPELINE_ABORTED"; reason: string; timestamp: string };

// ── Derived state ─────────────────────────────────────────────────────────

export interface PipelineState {
  ticketKey: string;
  currentStage: StageId | null;
  completedStages: StageId[];
  failedStage: StageId | null;
  pendingClarification: boolean;
  pendingHumanApproval: boolean;
  branchName: string | null;
  prNumber: number | null;
  isCompleted: boolean;
  isAborted: boolean;
  abortReason: string | null;
  startedAt: string | null;
}

const INITIAL_STATE: PipelineState = {
  ticketKey: "",
  currentStage: null,
  completedStages: [],
  failedStage: null,
  pendingClarification: false,
  pendingHumanApproval: false,
  branchName: null,
  prNumber: null,
  isCompleted: false,
  isAborted: false,
  abortReason: null,
  startedAt: null,
};

function applyEvent(state: PipelineState, event: PipelineEvent): PipelineState {
  switch (event.type) {
    case "STARTED":
      return {
        ...state,
        ticketKey: event.ticketKey,
        startedAt: event.timestamp,
      };
    case "STAGE_STARTED":
      return { ...state, currentStage: event.stage };
    case "STAGE_COMPLETED": {
      const output = event.output as Record<string, unknown>;
      return {
        ...state,
        currentStage: null,
        completedStages: [...state.completedStages, event.stage],
        branchName: (output?.branchName as string) ?? state.branchName,
        prNumber: (output?.prNumber as number) ?? state.prNumber,
      };
    }
    case "STAGE_FAILED":
      return { ...state, currentStage: null, failedStage: event.stage };
    case "STAGE_SKIPPED":
      return {
        ...state,
        completedStages: [...state.completedStages, event.stage],
      };
    case "CLARIFICATION_REQUESTED":
      return { ...state, pendingClarification: true };
    case "CLARIFICATION_RECEIVED":
      return { ...state, pendingClarification: false };
    case "HUMAN_APPROVAL_REQUESTED":
      return { ...state, pendingHumanApproval: true };
    case "HUMAN_APPROVED":
    case "HUMAN_REJECTED":
      return { ...state, pendingHumanApproval: false };
    case "PIPELINE_COMPLETED":
      return { ...state, isCompleted: true, currentStage: null };
    case "PIPELINE_ABORTED":
      return {
        ...state,
        isAborted: true,
        abortReason: event.reason,
        currentStage: null,
      };
    default:
      return state;
  }
}

// Distributes Omit over union members (standard Omit<Union, K> doesn't work on discriminated unions)
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

// ── State manager ─────────────────────────────────────────────────────────

export class StateManager {
  private readonly statePath: string;
  private events: PipelineEvent[] = [];

  constructor(private readonly runDir: string) {
    fs.mkdirSync(runDir, { recursive: true });
    this.statePath = path.join(runDir, "state.json");
    this.events = this.load();
  }

  emit(event: DistributiveOmit<PipelineEvent, "timestamp">): void {
    const full = {
      ...event,
      timestamp: new Date().toISOString(),
    } as PipelineEvent;
    fs.appendFileSync(this.statePath, JSON.stringify(full) + "\n");
    this.events.push(full);
  }

  get current(): PipelineState {
    return this.events.reduce(applyEvent, { ...INITIAL_STATE });
  }

  private load(): PipelineEvent[] {
    if (!fs.existsSync(this.statePath)) return [];
    return fs
      .readFileSync(this.statePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PipelineEvent);
  }
}

// ── Run directory helpers ─────────────────────────────────────────────────
// Runs live in ~/.jira-acp/runs/<projectName>/<ticketKey>/

export function getRunDir(projectName: string, ticketKey: string): string {
  return path.join(RUNS_DIR, projectName, ticketKey);
}

export function getLockPath(projectName: string, ticketKey: string): string {
  return path.join(getRunDir(projectName, ticketKey), `${ticketKey}.lock`);
}

export function getMemoryDir(projectName: string, ticketKey: string): string {
  return path.join(getRunDir(projectName, ticketKey), "memory");
}

export function getEvents(runDir: string): PipelineEvent[] {
  const storePath = path.join(runDir, "state.json");
  if (!fs.existsSync(storePath)) return [];
  return fs
    .readFileSync(storePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PipelineEvent);
}
