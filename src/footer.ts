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

import { info } from "@actions/core";
import { marked } from "marked";
import {
  includeCompareLink,
  mentionNewContributors,
  octokit,
  parseSemVer,
  releaseName,
  releaseNamePrefix,
  repository,
  semver,
  sha,
  useGithubAutolink,
} from "./utils/index.js";

export async function generateFooter(previousTagName?: string, previousSha?: string): Promise<string> {
  const { owner, repo, url } = repository();
  const tagName = releaseName();

  const footer: string[] = [];


  if (mentionNewContributors()) {
    const { rest } = octokit();

    const { data } = await rest.repos.generateReleaseNotes({
      owner,
      repo,
      tag_name         : tagName,
      previous_tag_name: previousTagName,
    });

    const tokens = marked.lexer(data.body);

    // eslint-disable-next-line max-len
    const index = tokens.findIndex(markdownToken => markdownToken.type === "heading" && markdownToken.text === "New Contributors");

    const markdownToken = tokens[index + 1];

    if (markdownToken.type === "list") footer.push(`## New Contributors\n${ markdownToken.raw }\n`);
  }

  if (includeCompareLink() && (previousTagName || previousSha)) {
    // Check if we're dealing with a prerelease
    const isPrerelease = semver() ? (parseSemVer()?.prerelease.length ?? 0) > 0 : false;
    let link: string;

    if (isPrerelease && previousSha) {
      // For prereleases, always use SHA-based comparison
      info(`📊 [CHANGELOG] Using SHA-based comparison for prerelease`);
      link = `${url}/compare/${encodeURIComponent(previousSha)}...${encodeURIComponent(sha())}`;

      if (!useGithubAutolink() || releaseNamePrefix()) {
        link = `[${previousSha.substring(0, 7)}...${sha().substring(0, 7)}](${link})`;
      }
    } else if (previousTagName) {
      // For regular releases, use tag-based comparison
      info(`📊 [CHANGELOG] Using tag-based comparison for regular release`);
      link = `${url}/compare/${encodeURIComponent(previousTagName)}...${encodeURIComponent(tagName)}`;

      if (!useGithubAutolink() || releaseNamePrefix()) {
        link = `[${previousTagName}...${tagName}](${link})`;
      }
    } else {
      // Fallback in case we don't have a previous reference
      info(`📊 [CHANGELOG] No previous reference available for comparison link`);
      return footer.join("\n\n");
    }

    footer.push(`**Full Changelog**: ${link}`);
  }

  if (footer.length > 0) footer.unshift("");

  return footer.join("\n\n");
}
