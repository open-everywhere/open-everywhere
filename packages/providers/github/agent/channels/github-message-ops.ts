import type { SurfaceMessageOps } from "@open-everywhere/core/agent/adapter-api.js";
import { liveGitHubEditComment, liveGitHubPost } from "./github-post-arm.js";
import { parseGithubContainer } from "./github-read.js";

function requireContainer(channelId: string): { readonly owner: string; readonly repo: string; readonly repoFull: string; readonly number: number } {
  const target = parseGithubContainer(channelId);
  if (!target) throw new Error(`GitHub surface message ops: "${channelId}" is not a conversation id (expected "owner/repo#number").`);
  return target;
}

export const githubMessageOps: SurfaceMessageOps = {
  platform: "github",

  async postText(channelId, text) {
    const { owner, repo, number } = requireContainer(channelId);
    return liveGitHubPost({ platform: "github", owner, repo, issueNumber: number }, text);
  },

  async editMessage(channelId, messageId, text) {
    const { repoFull } = requireContainer(channelId);
    await liveGitHubEditComment(repoFull, messageId, text);
  },
};
