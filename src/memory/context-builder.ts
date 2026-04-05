import fs from "node:fs";
import path from "node:path";
import type { StageId } from "../config/schema.js";

export function writeTicketContext(
  memoryDir: string,
  ticket: {
    key: string;
    summary: string;
    description: string;
    acceptanceCriteria: string;
    priority: string;
    clarifications?: string;
  },
): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  const content = `# Ticket: ${ticket.key}

## Summary
${ticket.summary}

## Description
${ticket.description || "(none)"}

## Acceptance Criteria
${ticket.acceptanceCriteria || "(none)"}

## Priority
${ticket.priority}
${ticket.clarifications ? `\n## Clarifications from Team\n${ticket.clarifications}` : ""}
`;
  fs.writeFileSync(path.join(memoryDir, "ticket-context.md"), content);
}

export function readTicketContext(memoryDir: string): string {
  const p = path.join(memoryDir, "ticket-context.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

export function appendClarifications(memoryDir: string, answers: string): void {
  const p = path.join(memoryDir, "ticket-context.md");
  if (fs.existsSync(p)) {
    fs.appendFileSync(p, `\n## Clarifications from Team\n${answers}\n`);
  }
}

export function writeReviewFeedback(
  memoryDir: string,
  feedback: {
    prNumber: number;
    issues: { severity: "minor" | "major"; message: string }[];
    autoResolved: boolean;
  },
): void {
  const lines = [
    `# Review Results`,
    `PR: #${feedback.prNumber}`,
    `Major issues: ${feedback.issues.filter((i) => i.severity === "major").length}`,
    `Minor issues: ${feedback.issues.filter((i) => i.severity === "minor").length}`,
    `Auto-resolved: ${feedback.autoResolved}`,
    "",
    "## Issues",
    ...feedback.issues.map(
      (i) => `- [${i.severity.toUpperCase()}] ${i.message}`,
    ),
  ];
  fs.writeFileSync(
    path.join(memoryDir, "review-feedback.md"),
    lines.join("\n"),
  );
}

export function getContextFilesForStage(
  projectDir: string,
  memoryDir: string,
  stage: StageId,
): string[] {
  const claudeMd = path.join(projectDir, ".claude", "CLAUDE.md");
  const ticketCtx = path.join(memoryDir, "ticket-context.md");
  const reviewFeedback = path.join(memoryDir, "review-feedback.md");

  const files: string[] = [];
  if (fs.existsSync(claudeMd)) files.push(claudeMd);

  if (["code", "git", "review", "deploy", "test", "notify"].includes(stage)) {
    if (fs.existsSync(ticketCtx)) files.push(ticketCtx);
  }
  if (stage === "test" && fs.existsSync(reviewFeedback)) {
    files.push(reviewFeedback);
  }
  return files;
}
