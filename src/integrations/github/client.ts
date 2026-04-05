import { Octokit } from "@octokit/rest";

export interface GitHubClient {
  createBranch(base: string, branch: string): Promise<void>;
  createPR(opts: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<number>;
  mergePR(
    prNumber: number,
    strategy: "squash" | "merge" | "rebase",
  ): Promise<void>;
  addReviewers(prNumber: number, reviewers: string[]): Promise<void>;
  getPR(prNumber: number): Promise<{ state: string; merged: boolean }>;
  getRunStatus(
    branch: string,
  ): Promise<"pending" | "success" | "failure" | "unknown">;
}

export function createGitHubClient(
  token: string,
  owner: string,
  repo: string,
): GitHubClient {
  const octokit = new Octokit({ auth: token });

  return {
    async createBranch(base, branch) {
      const { data: ref } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${base}`,
      });
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha,
      });
    },

    async createPR({ title, body, head, base, draft = false }) {
      const { data } = await octokit.pulls.create({
        owner,
        repo,
        title,
        body,
        head,
        base,
        draft,
      });
      return data.number;
    },

    async mergePR(prNumber, strategy) {
      const mergeMethod =
        strategy === "squash"
          ? "squash"
          : strategy === "rebase"
            ? "rebase"
            : "merge";
      await octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: mergeMethod,
      });
    },

    async addReviewers(prNumber, reviewers) {
      if (reviewers.length === 0) return;
      await octokit.pulls.requestReviewers({
        owner,
        repo,
        pull_number: prNumber,
        reviewers,
      });
    },

    async getPR(prNumber) {
      const { data } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return { state: data.state, merged: data.merged };
    },

    async getRunStatus(branch) {
      try {
        const { data } = await octokit.repos.getCombinedStatusForRef({
          owner,
          repo,
          ref: branch,
        });
        if (data.state === "success") return "success";
        if (data.state === "failure") return "failure";
        return "pending";
      } catch {
        return "unknown";
      }
    },
  };
}
