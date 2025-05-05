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

import { debug, info } from "@actions/core";
import { type SemVer } from "semver";
import { octokit, parseSemVer, releaseName, repository, semver, sha } from "./utils/index.js";

export interface TagInfoI {
  prerelease: boolean;

  previous?: {
    name: string;
    sha: string;
  };

  releaseId: string;
}

export async function getTagInfo(): Promise<TagInfoI> {
  const { paginate, rest } = octokit();
  const { owner, repo } = repository();

  const tagInfo: TagInfoI = {
    releaseId : "latest",
    prerelease: false,
  };

  let semVer: SemVer | null = null;

  if (semver()) {
    semVer = parseSemVer();

    if (semVer == null) throw new Error(`Expected a semver compatible releaseName, got "${ releaseName() }" instead.`);

    tagInfo.prerelease = semVer.prerelease.length > 0;

    info("[CHANGELOG DEBUG] Current release name: " + releaseName());
    info("[CHANGELOG DEBUG] Parsed as semver: " + JSON.stringify({
      version: semVer.version,
      major: semVer.major,
      minor: semVer.minor,
      patch: semVer.patch,
      prerelease: semVer.prerelease,
      isPrerelease: tagInfo.prerelease
    }));

    if (tagInfo.prerelease) tagInfo.releaseId = `${ semVer.prerelease[0] }`;
  }

  const iterator = paginate.iterator(
    rest.repos.listTags,
    {
      per_page: 100,
      owner,
      repo,
    },
  );

  info("[CHANGELOG DEBUG] Current commit SHA: " + sha());
  info("[CHANGELOG DEBUG] Starting tag comparison...");

  loop: for await (const { data } of iterator) {
    for (const { name, commit } of data) {
      info("[CHANGELOG DEBUG] Analyzing tag: " + name + " (SHA: " + commit.sha + ")");

      if (sha() === commit.sha) {
        info("[CHANGELOG DEBUG] Skipping tag with same SHA as current");
        continue;
      }

      if (semVer == null) {
        info("[CHANGELOG DEBUG] No semver mode - selecting first available tag");
        tagInfo.previous = {
          name,
          sha: commit.sha,
        };

        break loop;
      }

      const version = parseSemVer(name);

      if (version == null) {
        info("[CHANGELOG DEBUG] Tag " + name + " is not a valid semver format, skipping");
        continue;
      }

      if (semVer.compare(version) <= 0) {
        info("[CHANGELOG DEBUG] Tag " + name + " is not older than current version, skipping");
        continue;
      }

      // Check if prerelease suffixes are compatible
      const currentHasPrerelease = semVer.prerelease.length > 0;
      const versionHasPrerelease = version.prerelease.length > 0;

      info("[CHANGELOG DEBUG] Comparing prereleases: Current="
           + (currentHasPrerelease ? semVer.prerelease[0] : "none")
           + ", Tag="
           + (versionHasPrerelease ? version.prerelease[0] : "none"));

      // If current version has a prerelease suffix (e.g., v1.0.1-develop)
      if (currentHasPrerelease) {
        // When looking for a tag with prerelease (e.g., v1.0.1-develop),
        // we only want to compare with other tags having the same first prerelease identifier
        // For example, v1.0.0-develop should only be compared with other v*-develop tags
        if (versionHasPrerelease) {
          // Check if prerelease suffix is different (e.g., "develop" vs "beta")
          if (semVer.prerelease[0] !== version.prerelease[0]) {
            info("[CHANGELOG DEBUG] Different prerelease identifier, skipping");
            continue; // Skip tags with different suffixes
          }
        } else {
          // If current version has prerelease but the analyzed tag doesn't,
          // we skip it (unless we want to include stable releases as base)
          info("[CHANGELOG DEBUG] Current version has prerelease but tag doesn't, skipping");
          continue;
        }
      } else {
        // If current version is stable (no prerelease),
        // we ignore tags with prerelease as before
        if (versionHasPrerelease) {
          info("[CHANGELOG DEBUG] Current version is stable but tag has prerelease, skipping");
          continue;
        }
      }

      info("[CHANGELOG DEBUG] Selected as previous tag: " + name);
      tagInfo.previous = {
        name,
        sha: commit.sha,
      };

      break loop;
    }
  }

  if (tagInfo.previous) {
    info("[CHANGELOG DEBUG] Final selection - Previous tag: " + tagInfo.previous.name + " (SHA: " + tagInfo.previous.sha + ")");
  } else {
    info("[CHANGELOG DEBUG] No previous tag found for comparison");
  }

  return tagInfo;
}
