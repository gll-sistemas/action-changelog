/*
 * MIT License
 *
 * Copyright (c) 2020-2023 Ardalan Amini
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */

import { debug, info, warning } from "@actions/core";
import {
  commitTypes,
  defaultCommitType,
  includeCommitLinks,
  includePRLinks,
  mentionAuthors,
  octokit,
  parseCommitMessage,
  repository,
  sha,
  useGithubAutolink,
} from "./utils/index.js";

interface TypeGroupI {
  scopes: ScopeGroupI[];
  type: string;
}

interface ScopeGroupI {
  logs: LogI[];
  scope: string;
}

interface LogI {
  breaking: boolean;
  description: string;
  references: string[];
}

function trim<T extends string | undefined>(value: T): T {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (value == null) return value;

  return value.trim().replace(/ {2,}/g, " ") as never;
}

function unique(value: string[]): string[] {
  return [...new Set(value)];
}

function sortBy<T>(array: T[], property: keyof T): T[] {
  return array.sort((a, b) => (a[property] as string).localeCompare(b[property] as string));
}

// Helper function to generate the final changelog string
function formatChangelog(typeGroups: TypeGroupI[], typeMap: Record<string, string>, defaultType: string): string {
  const types = unique(Object.values(typeMap).concat(defaultType));
  const changelog: string[] = [];

  for (const type of types) {
    const typeGroup = typeGroups.find(log => log.type === type);

    if (typeGroup == null) continue;

    changelog.push(`## ${type}`);

    sortBy(typeGroup.scopes, "scope");

    for (const { scope, logs } of typeGroup.scopes) {
      let prefix = "";

      if (scope.length > 0) {
        changelog.push(`* **${scope}:**`);

        prefix = "  ";
      }

      for (const { breaking, description, references } of logs) {
        let line = `${prefix}* ${breaking ? "***breaking:*** " : ""}${description}`;

        if (references.length > 0) line += ` (${references.join(", ")})`;

        changelog.push(line);
      }
    }

    changelog.push("");
  }

  return changelog.join("\n");
}

/**
 * Checks if two references (tags or SHAs) point to the same code state
 * using multiple approaches to ensure accuracy
 */
async function areTagsEffectivelyIdentical(baseRef: string, headRef: string): Promise<boolean> {
  try {
    const { rest } = octokit();
    const { owner, repo } = repository();

    info(`🔍 [CHANGELOG] Checking identity between ${baseRef} and ${headRef}`);

    // Normalize references to handle development tags (v1.0.x-develop)
    const normalizeRef = (ref: string): string => {
      // Clean the ref to remove refs/* prefixes if they exist
      const cleanRef = ref.replace(/^refs\/(tags|heads)\//, '');
      return cleanRef;
    };

    const baseRefNormalized = normalizeRef(baseRef);
    const headRefNormalized = normalizeRef(headRef);

    info(`🔍 [CHANGELOG] Normalized references: ${baseRefNormalized} and ${headRefNormalized}`);

    // Special case: Check if references represent sequential development versions
    // Ex: v1.0.17-develop and v1.0.18-develop which are often identical
    const devTagPattern = /^v(\d+)\.(\d+)\.(\d+)-develop$/;
    const baseMatches = baseRefNormalized.match(devTagPattern);
    const headMatches = headRefNormalized.match(devTagPattern);

    if (baseMatches && headMatches) {
      info(`🔍 [CHANGELOG] Development tags detected: ${baseRefNormalized} and ${headRefNormalized}`);

      // If both are development tags, we'll do additional checks
      try {
        // First approach: Directly check comparison via API
        const compareResult = await rest.repos.compareCommits({
          owner,
          repo,
          base: baseRefNormalized,
          head: headRefNormalized,
        });

        // Special checks for development tags:

        // 1. If there are no differences, the API says ahead_by = 0 and behind_by = 0
        if (compareResult.data.ahead_by === 0 && compareResult.data.behind_by === 0) {
          info(`🔍 [CHANGELOG] GitHub API confirms references are identical (ahead_by = 0, behind_by = 0)`);
          return true;
        }

        // 2. If there are only merges or empty commits, might have ahead_by > 0 but files_count = 0
        if (compareResult.data.files?.length === 0) {
          info(`🔍 [CHANGELOG] Comparison shows no file changes (files_count = 0)`);
          return true;
        }

        // 3. Special status for the sequential tags issue
        if (compareResult.data.status === "identical") {
          info(`🔍 [CHANGELOG] API returns "identical" status`);
          return true;
        }
      } catch (error) {
        info(`🔍 [CHANGELOG] Error during special check for development tags: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Additional check for sequential development tags (v1.0.x-develop)
      // Extract version numbers
      const [_, baseMajor, baseMinor, basePatch] = baseMatches.map(Number);
      const [__, headMajor, headMinor, headPatch] = headMatches.map(Number);

      // If versions are sequential (only patch changes by +1)
      if (baseMajor === headMajor && baseMinor === headMinor &&
          Math.abs(headPatch - basePatch) === 1) {
        info(`🔍 [CHANGELOG] Sequential development tags detected: ${baseRefNormalized} and ${headRefNormalized}`);

        try {
          // Get the real commit SHAs for the tags
          const baseTagData = await rest.git.getRef({
            owner,
            repo,
            ref: `tags/${baseRefNormalized}`
          }).catch(() => rest.git.getRef({
            owner,
            repo,
            ref: `heads/${baseRefNormalized}`
          }));

          const headTagData = await rest.git.getRef({
            owner,
            repo,
            ref: `tags/${headRefNormalized}`
          }).catch(() => rest.git.getRef({
            owner,
            repo,
            ref: `heads/${headRefNormalized}`
          }));

          // Get the complete tag objects (which may point to tags or commits)
          if (baseTagData && headTagData) {
            const baseTagSha = baseTagData.data.object.sha;
            const headTagSha = headTagData.data.object.sha;

            // For sequential tags, if they point to the same object, they are identical
            if (baseTagSha === headTagSha) {
              info(`🔍 [CHANGELOG] Sequential tags point to the same object: ${baseTagSha}`);
              return true;
            }

            // Check if they are annotated or lightweight tags
            const baseTagType = baseTagData.data.object.type;
            const headTagType = headTagData.data.object.type;

            // For annotated tags, we need to get the commit they point to
            let baseCommitSha = baseTagSha;
            let headCommitSha = headTagSha;

            if (baseTagType === 'tag') {
              const baseTagObject = await rest.git.getTag({
                owner,
                repo,
                tag_sha: baseTagSha
              });
              baseCommitSha = baseTagObject.data.object.sha;
            }

            if (headTagType === 'tag') {
              const headTagObject = await rest.git.getTag({
                owner,
                repo,
                tag_sha: headTagSha
              });
              headCommitSha = headTagObject.data.object.sha;
            }

            // If commit SHAs are equal, tags are identical
            if (baseCommitSha === headCommitSha) {
              info(`🔍 [CHANGELOG] Sequential tags point to the same commit: ${baseCommitSha}`);
              return true;
            }

            // Get the commits
            const baseCommit = await rest.git.getCommit({
              owner,
              repo,
              commit_sha: baseCommitSha
            });

            const headCommit = await rest.git.getCommit({
              owner,
              repo,
              commit_sha: headCommitSha
            });

            // Compare tree SHAs - two tags that have the same tree SHA have the same code state
            if (baseCommit.data.tree.sha === headCommit.data.tree.sha) {
              info(`🔍 [CHANGELOG] Sequential tags have identical trees: ${baseCommit.data.tree.sha}`);
              return true;
            }
          }
        } catch (error) {
          info(`🔍 [CHANGELOG] Error comparing tag trees: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Standard check for all references
    try {
      // First approach: Check comparison directly via API
      const compareResult = await rest.repos.compareCommits({
        owner,
        repo,
        base: baseRef,
        head: headRef,
      });

      // If no differences, API says ahead_by = 0 and behind_by = 0
      if (compareResult.data.ahead_by === 0 && compareResult.data.behind_by === 0) {
        info(`🔍 [CHANGELOG] GitHub API confirms references are identical (ahead_by = 0, behind_by = 0)`);
        return true;
      }

      // If only merges or empty commits, might have ahead_by > 0 but files_count = 0
      if (compareResult.data.files?.length === 0) {
        info(`🔍 [CHANGELOG] Comparison shows no file changes (files_count = 0)`);
        return true;
      }

      // If status is identical, they are identical (even if ahead_by > 0)
      if (compareResult.data.status === "identical") {
        info(`🔍 [CHANGELOG] API returns "identical" status`);
        return true;
      }
    } catch (error) {
      info(`🔍 [CHANGELOG] Error comparing references via API: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Second approach: Compare tree SHAs directly
    try {
      // Resolve references to get the real SHAs
      const resolveRef = async (ref: string) => {
        try {
          // Try as tag
          const tagRef = await rest.git.getRef({
            owner,
            repo,
            ref: `tags/${ref.replace(/^refs\/tags\//, '')}`
          }).catch(() => null);

          if (tagRef) return tagRef;

          // Try as branch
          const branchRef = await rest.git.getRef({
            owner,
            repo,
            ref: `heads/${ref.replace(/^refs\/heads\//, '')}`
          }).catch(() => null);

          if (branchRef) return branchRef;

          // Try as direct SHA
          return rest.git.getCommit({
            owner,
            repo,
            commit_sha: ref
          });
        } catch (e) {
          return null;
        }
      };

      const baseRefData = await resolveRef(baseRef);
      const headRefData = await resolveRef(headRef);

      if (baseRefData && headRefData) {
        // If both are refs, compare the SHAs they point to
        if ('object' in baseRefData.data && 'object' in headRefData.data) {
          const baseSha = baseRefData.data.object.sha;
          const headSha = headRefData.data.object.sha;

          if (baseSha === headSha) {
            info(`🔍 [CHANGELOG] Refs point to the same SHA: ${baseSha}`);
            return true;
          }

          // If different objects, check their trees
          const baseCommit = await rest.git.getCommit({
            owner,
            repo,
            commit_sha: baseSha
          }).catch(() => null);

          const headCommit = await rest.git.getCommit({
            owner,
            repo,
            commit_sha: headSha
          }).catch(() => null);

          if (baseCommit && headCommit &&
              baseCommit.data.tree.sha === headCommit.data.tree.sha) {
            info(`🔍 [CHANGELOG] Commits have the same tree SHA: ${baseCommit.data.tree.sha}`);
            return true;
          }
        }
      }
    } catch (error) {
      info(`🔍 [CHANGELOG] Error comparing trees: ${error instanceof Error ? error.message : String(error)}`);
    }

    info(`🔍 [CHANGELOG] References are different after multiple checks`);
    return false;
  } catch (error) {
    info(`🔍 [CHANGELOG] Global error when checking identity: ${error instanceof Error ? error.message : String(error)}`);
    return false; // In case of error, assume they're different for safety
  }
}

export async function generateChangelog(lastSha?: string): Promise<string> {
  const { paginate, rest } = octokit();
  const { owner, repo, url } = repository();
  const defaultType = defaultCommitType();
  const typeMap = commitTypes();
  const shouldIncludeCommitLinks = includeCommitLinks();
  const shouldIncludePRLinks = includePRLinks();
  const shouldMentionAuthors = mentionAuthors();
  const shouldUseGithubAutolink = useGithubAutolink();

  // Fixed: Using paginate correctly with the new API structure
  const tags = await paginate(rest.repos.listTags, {
    owner,
    repo,
    per_page: 100,
  });

  let targetSha = lastSha;
  let initialAttemptWithLastSha = !!lastSha;
  let retryCount = 0;
  const MAX_RETRIES = 5; // Limit to avoid infinite loops

  // Continue iterating when tags are effectively identical
  while (retryCount < MAX_RETRIES) {
    info(`🔍 [CHANGELOG] Attempt ${retryCount + 1} to generate changelog${targetSha ? ` starting from ${targetSha.substring(0, 7)}` : ''}`);

    let commits: any[] = [];

    if (targetSha) {
      const currentSha = sha();

      // Check if tags are effectively identical
      if (await areTagsEffectivelyIdentical(targetSha, currentSha)) {
        info(`🔍 [CHANGELOG] Tags are effectively identical: ${targetSha.substring(0, 7)} and ${currentSha.substring(0, 7)}`);

        // Find the next tag in history to continue iteration
        const currentTagIndex = tags.findIndex(tag => tag.commit.sha === currentSha);
        const previousTagIndex = tags.findIndex(tag => tag.commit.sha === targetSha);

        // If both tags are in history and are close, continue to the next
        if (currentTagIndex >= 0 && previousTagIndex >= 0) {
          const nextTagIndex = Math.max(previousTagIndex, currentTagIndex) + 1;

          if (nextTagIndex < tags.length) {
            targetSha = tags[nextTagIndex].commit.sha;
            info(`🔍 [CHANGELOG] Continuing to next tag: ${tags[nextTagIndex].name} (${targetSha.substring(0, 7)})`);
            retryCount++;
            continue;
          }
        }

        // If we can't find a next tag, try using the parent commit
        try {
          const commit = await rest.git.getCommit({
            owner,
            repo,
            commit_sha: targetSha,
          });

          if (commit.data.parents.length > 0) {
            targetSha = commit.data.parents[0].sha;
            info(`🔍 [CHANGELOG] Continuing to parent commit: ${targetSha.substring(0, 7)}`);
            retryCount++;
            continue;
          }
        } catch (error) {
          info(`🔍 [CHANGELOG] Error getting parent commit: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      info(`🔍 [CHANGELOG] Getting commits between ${targetSha.substring(0, 7)} and ${currentSha.substring(0, 7)}`);

      try {
        // Fixed: Adjusted to work with the new response type
        const compareResult = await rest.repos.compareCommits({
          owner,
          repo,
          base: targetSha,
          head: currentSha,
          per_page: 100,
        });

        // Access commits directly from response object
        commits = compareResult.data.commits;
      } catch (error) {
        // If failed with lastSha, try with all commits
        warning(`Failed to compare commits: ${error instanceof Error ? error.message : String(error)}`);

        if (initialAttemptWithLastSha) {
          info("Falling back to all commits...");
          targetSha = undefined;
          initialAttemptWithLastSha = false;
          continue;
        }

        throw error;
      }
    } else {
      info("🔍 [CHANGELOG] Getting all commits (no reference SHA provided)");

      const response = await paginate(rest.repos.listCommits, {
        owner,
        repo,
        per_page: 100,
      });

      commits = response;
    }

    const typeGroups: TypeGroupI[] = [];
    let commitCount = 0;
    let processedCommitCount = 0;

    for (const commit of commits) {
      commitCount++;
      const { message } = commit.commit;
      let parsed;

      try {
        parsed = parseCommitMessage(message);
      } catch (error) {
        debug(`Failed to parse commit message: ${error instanceof Error ? error.message : String(error)}`);
        debug(`Skipping commit "${message}"`);

        continue;
      }

      // Skip merge commits and revert commits
      if (parsed == null || parsed.merge || parsed.revert) continue;

      const { type } = parsed;

      // Skip if type is not valid in typeMap
      if (type.length === 0 || !(type in typeMap)) continue;

      processedCommitCount++;

      const { scope, description, breaking, pr } = parsed;

      let typeGroup = typeGroups.find(log => log.type === typeMap[type]);

      if (typeGroup == null) {
        typeGroup = {
          type: typeMap[type],
          scopes: [],
        };

        typeGroups.push(typeGroup);
      }

      let scopeGroup = typeGroup.scopes.find(log => log.scope === scope);

      if (scopeGroup == null) {
        scopeGroup = {
          scope,
          logs: [],
        };

        typeGroup.scopes.push(scopeGroup);
      }

      let log = scopeGroup.logs.find(record => record.description === description);

      if (log == null) {
        log = {
          breaking,
          description,
          references: [],
        };

        scopeGroup.logs.push(log);
      }

      const reference: string[] = [];

      if (pr && shouldIncludePRLinks) reference.push(shouldUseGithubAutolink ? `#${pr}` : `[#${pr}](${url}/issues/${pr})`);
      else if (shouldIncludeCommitLinks) reference.push(shouldUseGithubAutolink ? commit.sha : `[${commit.sha.substring(0, 7)}](${url}/commit/${commit.sha})`);

      const username = commit.author?.login;

      if (username && shouldMentionAuthors) {
        const mention = `by @${username}`;

        reference.push(mention);

        const lastReference = log.references[log.references.length - 1];

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (lastReference?.endsWith(mention)) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          log.references.push(log.references.pop()!.replace(mention, `& ${reference.join(" ")}`));

          continue;
        }
      }

      if (reference.length > 0) log.references.push(reference.join(" "));
    }

    // If no commits were processed, try again with the next tag if we're in retry mode
    if (processedCommitCount === 0 && retryCount > 0 && retryCount < MAX_RETRIES) {
      // Try to find a previous tag to retry
      const currentTagIndex = tags.findIndex(tag => tag.commit.sha === targetSha);

      if (currentTagIndex >= 0 && currentTagIndex + 1 < tags.length) {
        targetSha = tags[currentTagIndex + 1].commit.sha;
        info(`🔍 [CHANGELOG] No processed commits, trying with next tag: ${tags[currentTagIndex + 1].name} (${targetSha.substring(0, 7)})`);
        retryCount++;
        continue;
      }
    }

    // If no commits were processed, return message indicating no significant changes
    if (processedCommitCount === 0 && lastSha) {
      info(`🔍 [CHANGELOG] No significant changes found for changelog (all commits were filtered)`);
      return "## No significant changes in this release\n\n**Full Changelog**: " +
            `${url}/compare/${encodeURIComponent(lastSha)}...${encodeURIComponent(sha())}`;
    }

    info(`🔍 [CHANGELOG] Changelog generation completed with legacy method`);
    info(`🔍 [CHANGELOG] Commits analyzed: ${commitCount}`);
    info(`🔍 [CHANGELOG] Commits included in changelog: ${processedCommitCount}`);

    if (lastSha) {
      info(`🔍 [CHANGELOG] Comparison: From SHA ${lastSha.substring(0, 7)} to ${sha().substring(0, 7)}`);
    } else {
      info(`🔍 [CHANGELOG] No previous SHA found for comparison, included all accessible commits`);
    }

    return formatChangelog(typeGroups, typeMap, defaultType);
  }

  // If we got here, we reached the retry limit
  info(`🔍 [CHANGELOG] Reached limit of ${MAX_RETRIES} attempts to generate a valid changelog`);
  return "## Unable to generate changelog after multiple attempts\n\n" +
         "No significant changes could be found between the compared versions after multiple attempts.";
}
