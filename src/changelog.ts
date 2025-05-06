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

    changelog.push(`## ${ type }`);

    sortBy(typeGroup.scopes, "scope");

    for (const { scope, logs } of typeGroup.scopes) {
      let prefix = "";

      if (scope.length > 0) {
        changelog.push(`* **${ scope }:**`);

        prefix = "  ";
      }

      for (const { breaking, description, references } of logs) {
        let line = `${ prefix }* ${ breaking ? "***breaking:*** " : "" }${ description }`;

        if (references.length > 0) line += ` (${ references.join(", ") })`;

        changelog.push(line);
      }
    }

    changelog.push("");
  }

  return changelog.join("\n");
}

export async function generateChangelog(lastSha?: string): Promise<string> {
  const { paginate, rest } = octokit();
  const { owner, repo, url } = repository();
  const defaultType = defaultCommitType();
  const typeMap = commitTypes();
  const shouldIncludePRLinks = includePRLinks();
  const shouldIncludeCommitLinks = includeCommitLinks();
  const shouldMentionAuthors = mentionAuthors();
  const shouldUseGithubAutolink = useGithubAutolink();

  info(`🔍 [CHANGELOG] Generating changelog`);
  info(`🔍 [CHANGELOG] Current SHA: ${sha()}`);
  info(`🔍 [CHANGELOG] Previous SHA (lastSha): ${lastSha || "none"}`);

  const typeGroups: TypeGroupI[] = [];
  let commitCount = 0;
  let processedCommitCount = 0;

  // Return empty changelog if the two SHAs are the same
  if (lastSha === sha()) {
    info(`🔍 [CHANGELOG] Current SHA and previous SHA are the same, no changes to include in changelog`);
    return "## No changes in this release\n\n**No changes detected between these releases.**";
  }

  // If we have a lastSha, use compareCommits to get commits between the two SHAs
  if (lastSha) {
    info(`🔍 [CHANGELOG] Using compare API to fetch commits between ${lastSha.substring(0, 7)} and ${sha().substring(0, 7)}`);

    try {
      // First check if there are any changes between the two SHAs
      const compareResult = await rest.repos.compareCommits({
        owner,
        repo,
        base: lastSha,
        head: sha(),
      });

      info(`🔍 [CHANGELOG] Compare API status: ${compareResult.status}, total commits: ${compareResult.data.total_commits}, ahead by: ${compareResult.data.ahead_by}, behind by: ${compareResult.data.behind_by}`);

      // If there are no commits ahead, there are no changes to include in the changelog
      if (compareResult.data.ahead_by === 0) {
        info(`🔍 [CHANGELOG] No commits ahead of the base SHA, no changes to include in changelog`);
        return "## No changes in this release\n\n**No changes detected between these releases.**";
      }

      if (compareResult.data.commits.length === 0) {
        info(`🔍 [CHANGELOG] Compare API returned no commits between the SHAs, even though ahead_by > 0`);
        info(`🔍 [CHANGELOG] This is unusual and may indicate an issue with the GitHub API response`);
        warning(`Compare API reported ${compareResult.data.ahead_by} commits ahead but returned 0 commits. Check GitHub API response.`);
        return "## No significant changes detected\n\n**Full Changelog**: " +
               `${url}/compare/${encodeURIComponent(lastSha)}...${encodeURIComponent(sha())}`;
      }

      info(`🔍 [CHANGELOG] Found ${compareResult.data.commits.length} commits between the two SHAs`);

      // Track commits that should be excluded from the changelog
      let mergeCommits = 0;
      let emptyDescriptionCommits = 0;
      let ignoredCommits = 0;

      // Process each commit from the comparison
      for (const commit of compareResult.data.commits) {
        commitCount++;

        const message = commit.commit.message.split("\n")[0];
        const commitSHA = commit.sha.substring(0, 7);
        debug(`commit message -> ${ message }`);

        // Skip merge commits
        if (message.startsWith("Merge ") || message.includes(" into ") || message.includes("//github.com")) {
          info(`🔍 [CHANGELOG] Commit ${commitSHA} skipped: Merge commit`);
          mergeCommits++;
          continue;
        }

        let { type, scope, description, pr, flag, breaking } = parseCommitMessage(message);

        if (!description) {
          info(`🔍 [CHANGELOG] Commit ${commitSHA} skipped: No description`);
          emptyDescriptionCommits++;
          continue;
        }

        description = trim(description);
        flag = trim(flag);

        if (flag === "ignore") {
          info(`🔍 [CHANGELOG] Commit ${commitSHA} skipped: Flagged as ignore`);
          ignoredCommits++;
          continue;
        }

        processedCommitCount++;

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        type = typeMap[trim(type ?? "")] ?? defaultType;

        // Logging for every 10th commit to avoid excessive logs
        if (processedCommitCount % 10 === 0 || processedCommitCount < 5) {
          info(`🔍 [CHANGELOG] Processing commit ${commitSHA}: ${type}${scope ? `(${scope})` : ""}: ${description}`);
        }

        let typeGroup = typeGroups.find(record => record.type === type);

        if (typeGroup == null) {
          typeGroup = {
            type,
            scopes: [],
          };

          typeGroups.push(typeGroup);
        }

        scope = trim(scope ?? "");

        let scopeGroup = typeGroup.scopes.find(record => record.scope === scope);

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

        if (pr && shouldIncludePRLinks) reference.push(shouldUseGithubAutolink ? `#${ pr }` : `[#${ pr }](${ url }/issues/${ pr })`);
        else if (shouldIncludeCommitLinks) reference.push(shouldUseGithubAutolink ? commit.sha : `[${ commit.sha.substring(0, 7) }](${ url }/commit/${ commit.sha })`);

        const username = commit.author?.login;

        if (username && shouldMentionAuthors) {
          const mention = `by @${ username }`;

          reference.push(mention);

          const lastReference = log.references[log.references.length - 1];

          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (lastReference?.endsWith(mention)) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            log.references.push(log.references.pop()!.replace(mention, `& ${ reference.join(" ") }`));

            continue;
          }
        }

        if (reference.length > 0) log.references.push(reference.join(" "));
      }

      // Log statistics about skipped commits
      info(`🔍 [CHANGELOG] Merge commits skipped: ${mergeCommits}`);
      info(`🔍 [CHANGELOG] Commits with empty descriptions skipped: ${emptyDescriptionCommits}`);
      info(`🔍 [CHANGELOG] Commits flagged as ignore skipped: ${ignoredCommits}`);

      // If no commits were processed, return a message indicating no significant changes
      if (processedCommitCount === 0) {
        info(`🔍 [CHANGELOG] No significant changes found for the changelog (all commits were filtered out)`);
        return "## No significant changes in this release\n\n**Full Changelog**: " +
               `${url}/compare/${encodeURIComponent(lastSha)}...${encodeURIComponent(sha())}`;
      }

      info(`🔍 [CHANGELOG] Successfully used compare API to generate changelog`);
      info(`🔍 [CHANGELOG] Changelog generation complete`);
      info(`🔍 [CHANGELOG] Commits analyzed: ${commitCount}`);
      info(`🔍 [CHANGELOG] Commits included in changelog: ${processedCommitCount}`);
      info(`🔍 [CHANGELOG] Comparison: From SHA ${lastSha.substring(0, 7)} to ${sha().substring(0, 7)}`);

      return formatChangelog(typeGroups, typeMap, defaultType);
    } catch (error) {
      info(`🔍 [CHANGELOG] Error using compare API: ${error instanceof Error ? error.message : String(error)}`);
      info(`🔍 [CHANGELOG] Falling back to legacy list commits method`);
    }
  }

  // Legacy method or fallback if compareCommits fails or lastSha is not provided
  info(`🔍 [CHANGELOG] Using legacy method to fetch commits`);

  const iterator = paginate.iterator(
    rest.repos.listCommits,
    {
      per_page: 100,
      sha     : sha(),
      owner,
      repo,
    },
  );

  info(`🔍 [CHANGELOG] Fetching commits between current SHA and lastSha`);

  paginator: for await (const { data } of iterator) {
    for (const commit of data) {
      commitCount++;

      if (lastSha && commit.sha === lastSha) {
        info(`🔍 [CHANGELOG] Found lastSha commit (${lastSha.substring(0, 7)}), stopping commit processing`);
        break paginator;
      }

      const message = commit.commit.message.split("\n")[0];
      debug(`commit message -> ${ message }`);

      // Skip merge commits
      if (message.startsWith("Merge ") || message.includes(" into ") || message.includes("//github.com")) {
        info(`🔍 [CHANGELOG] Commit ${commit.sha.substring(0, 7)} skipped: Merge commit`);
        continue;
      }

      let { type, scope, description, pr, flag, breaking } = parseCommitMessage(message);

      if (!description) {
        info(`🔍 [CHANGELOG] Commit ${commit.sha.substring(0, 7)} skipped: No description`);
        continue;
      }

      description = trim(description);

      flag = trim(flag);

      if (flag === "ignore") {
        info(`🔍 [CHANGELOG] Commit ${commit.sha.substring(0, 7)} skipped: Flagged as ignore`);
        continue;
      }

      processedCommitCount++;

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      type = typeMap[trim(type ?? "")] ?? defaultType;

      // Logging for every 10th commit to avoid excessive logs
      if (processedCommitCount % 10 === 0 || processedCommitCount < 5) {
        info(`🔍 [CHANGELOG] Processing commit ${commit.sha.substring(0, 7)}: ${type}${scope ? `(${scope})` : ""}: ${description}`);
      }

      let typeGroup = typeGroups.find(record => record.type === type);

      if (typeGroup == null) {
        typeGroup = {
          type,
          scopes: [],
        };

        typeGroups.push(typeGroup);
      }

      scope = trim(scope ?? "");

      let scopeGroup = typeGroup.scopes.find(record => record.scope === scope);

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

      if (pr && shouldIncludePRLinks) reference.push(shouldUseGithubAutolink ? `#${ pr }` : `[#${ pr }](${ url }/issues/${ pr })`);
      else if (shouldIncludeCommitLinks) reference.push(shouldUseGithubAutolink ? commit.sha : `[${ commit.sha.substring(0, 7) }](${ url }/commit/${ commit.sha })`);

      const username = commit.author?.login;

      if (username && shouldMentionAuthors) {
        const mention = `by @${ username }`;

        reference.push(mention);

        const lastReference = log.references[log.references.length - 1];

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (lastReference?.endsWith(mention)) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          log.references.push(log.references.pop()!.replace(mention, `& ${ reference.join(" ") }`));

          continue;
        }
      }

      if (reference.length > 0) log.references.push(reference.join(" "));
    }
  }

  // If no commits were processed, return a message indicating no significant changes
  if (processedCommitCount === 0 && lastSha) {
    info(`🔍 [CHANGELOG] No significant changes found for the changelog (all commits were filtered out)`);
    return "## No significant changes in this release\n\n**Full Changelog**: " +
           `${url}/compare/${encodeURIComponent(lastSha)}...${encodeURIComponent(sha())}`;
  }

  info(`🔍 [CHANGELOG] Changelog generation complete with legacy method`);
  info(`🔍 [CHANGELOG] Commits analyzed: ${commitCount}`);
  info(`🔍 [CHANGELOG] Commits included in changelog: ${processedCommitCount}`);

  if (lastSha) {
    info(`🔍 [CHANGELOG] Comparison: From SHA ${lastSha.substring(0, 7)} to ${sha().substring(0, 7)}`);
  } else {
    info(`🔍 [CHANGELOG] No previous SHA found for comparison, included all accessible commits`);
  }

  return formatChangelog(typeGroups, typeMap, defaultType);
}
