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
 * Verifica se duas referências (tags ou SHAs) apontam para o mesmo estado de código
 * usando múltiplas abordagens para garantir precisão
 */
async function areTagsEffectivelyIdentical(baseRef: string, headRef: string): Promise<boolean> {
  try {
    const { rest } = octokit();
    const { owner, repo } = repository();

    info(`🔍 [CHANGELOG] Verificando identidade entre ${baseRef} e ${headRef}`);

    // Normaliza as referências para manusear tags de desenvolvimento (v1.0.x-develop)
    const normalizeRef = (ref: string): string => {
      // Limpa a ref para remover prefixos refs/* se existirem
      const cleanRef = ref.replace(/^refs\/(tags|heads)\//, '');
      return cleanRef;
    };

    const baseRefNormalized = normalizeRef(baseRef);
    const headRefNormalized = normalizeRef(headRef);

    info(`🔍 [CHANGELOG] Referências normalizadas: ${baseRefNormalized} e ${headRefNormalized}`);

    // Caso especial: Verificar se as referências representam versões sequenciais de desenvolvimento
    // Ex: v1.0.17-develop e v1.0.18-develop que frequentemente são idênticas
    const devTagPattern = /^v(\d+)\.(\d+)\.(\d+)-develop$/;
    const baseMatches = baseRefNormalized.match(devTagPattern);
    const headMatches = headRefNormalized.match(devTagPattern);

    if (baseMatches && headMatches) {
      info(`🔍 [CHANGELOG] Detectadas tags de desenvolvimento: ${baseRefNormalized} e ${headRefNormalized}`);

      // Se ambos são tags de desenvolvimento, vamos fazer verificações adicionais
      try {
        // Primeira abordagem: Verificar diretamente a comparação via API
        const compareResult = await rest.repos.compareCommits({
          owner,
          repo,
          base: baseRefNormalized,
          head: headRefNormalized,
        });

        // Verificações especiais para tags de desenvolvimento:

        // 1. Se não há diferenças, a API diz que ahead_by = 0 e behind_by = 0
        if (compareResult.data.ahead_by === 0 && compareResult.data.behind_by === 0) {
          info(`🔍 [CHANGELOG] A API do GitHub confirma que as referências são idênticas (ahead_by = 0, behind_by = 0)`);
          return true;
        }

        // 2. Se há apenas merges ou commits vazios, pode ter ahead_by > 0 mas files_count = 0
        if (compareResult.data.files?.length === 0) {
          info(`🔍 [CHANGELOG] A comparação não mostra alterações em arquivos (files_count = 0)`);
          return true;
        }

        // 3. Status especial para o problema de tags sequenciais
        if (compareResult.data.status === "identical") {
          info(`🔍 [CHANGELOG] A API retorna status "identical"`);
          return true;
        }
      } catch (error) {
        info(`🔍 [CHANGELOG] Erro durante verificação especial de tags de desenvolvimento: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Verificação adicional para tags de desenvolvimento sequenciais (v1.0.x-develop)
      // Extrair os números de versão
      const [_, baseMajor, baseMinor, basePatch] = baseMatches.map(Number);
      const [__, headMajor, headMinor, headPatch] = headMatches.map(Number);

      // Se as versões são sequenciais (só o patch muda em +1)
      if (baseMajor === headMajor && baseMinor === headMinor &&
          Math.abs(headPatch - basePatch) === 1) {
        info(`🔍 [CHANGELOG] Tags de desenvolvimento sequenciais detectadas: ${baseRefNormalized} e ${headRefNormalized}`);

        try {
          // Obter os SHA reais dos commits para as tags
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

          // Obter os objetos completos dos tags (que podem apontar para tags ou commits)
          if (baseTagData && headTagData) {
            const baseTagSha = baseTagData.data.object.sha;
            const headTagSha = headTagData.data.object.sha;

            // Para tags sequenciais, se apontam para o mesmo objeto, são idênticas
            if (baseTagSha === headTagSha) {
              info(`🔍 [CHANGELOG] Tags sequenciais apontam para o mesmo objeto: ${baseTagSha}`);
              return true;
            }

            // Verificar se são tags anotadas ou lightweight
            const baseTagType = baseTagData.data.object.type;
            const headTagType = headTagData.data.object.type;

            // Para tags anotadas, precisamos pegar o commit para o qual elas apontam
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

            // Se os commit SHAs são iguais, as tags são idênticas
            if (baseCommitSha === headCommitSha) {
              info(`🔍 [CHANGELOG] Tags sequenciais apontam para o mesmo commit: ${baseCommitSha}`);
              return true;
            }

            // Obter os commits
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

            // Compare tree SHAs - duas tags que têm o mesmo tree SHA têm o mesmo estado do código
            if (baseCommit.data.tree.sha === headCommit.data.tree.sha) {
              info(`🔍 [CHANGELOG] Tags sequenciais têm trees idênticos: ${baseCommit.data.tree.sha}`);
              return true;
            }
          }
        } catch (error) {
          info(`🔍 [CHANGELOG] Erro ao comparar trees das tags: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Verificação padrão para todas as referências
    try {
      // Primeira abordagem: Verificar diretamente a comparação via API
      const compareResult = await rest.repos.compareCommits({
        owner,
        repo,
        base: baseRef,
        head: headRef,
      });

      // Se não há diferenças, a API diz que ahead_by = 0 e behind_by = 0
      if (compareResult.data.ahead_by === 0 && compareResult.data.behind_by === 0) {
        info(`🔍 [CHANGELOG] A API do GitHub confirma que as referências são idênticas (ahead_by = 0, behind_by = 0)`);
        return true;
      }

      // Se há apenas merges ou commits vazios, pode ter ahead_by > 0 mas files_count = 0
      if (compareResult.data.files?.length === 0) {
        info(`🔍 [CHANGELOG] A comparação não mostra alterações em arquivos (files_count = 0)`);
        return true;
      }

      // Se o status é identical, são idênticas (mesmo que ahead_by seja > 0)
      if (compareResult.data.status === "identical") {
        info(`🔍 [CHANGELOG] A API retorna status "identical"`);
        return true;
      }
    } catch (error) {
      info(`🔍 [CHANGELOG] Erro ao comparar referências via API: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Segunda abordagem: Comparar tree SHAs diretamente
    try {
      // Resolver referências para obter os SHAs reais
      const resolveRef = async (ref: string) => {
        try {
          // Tentar como tag
          const tagRef = await rest.git.getRef({
            owner,
            repo,
            ref: `tags/${ref.replace(/^refs\/tags\//, '')}`
          }).catch(() => null);

          if (tagRef) return tagRef;

          // Tentar como branch
          const branchRef = await rest.git.getRef({
            owner,
            repo,
            ref: `heads/${ref.replace(/^refs\/heads\//, '')}`
          }).catch(() => null);

          if (branchRef) return branchRef;

          // Tentar como SHA direto
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
        // Se ambos são refs, comparar os SHA para que apontam
        if ('object' in baseRefData.data && 'object' in headRefData.data) {
          const baseSha = baseRefData.data.object.sha;
          const headSha = headRefData.data.object.sha;

          if (baseSha === headSha) {
            info(`🔍 [CHANGELOG] Refs apontam para o mesmo SHA: ${baseSha}`);
            return true;
          }

          // Se são objetos diferentes, verificar seus trees
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
            info(`🔍 [CHANGELOG] Commits têm o mesmo tree SHA: ${baseCommit.data.tree.sha}`);
            return true;
          }
        }
      }
    } catch (error) {
      info(`🔍 [CHANGELOG] Erro ao comparar trees: ${error instanceof Error ? error.message : String(error)}`);
    }

    info(`🔍 [CHANGELOG] As referências são diferentes após múltiplas verificações`);
    return false;
  } catch (error) {
    info(`🔍 [CHANGELOG] Erro global ao verificar identidade: ${error instanceof Error ? error.message : String(error)}`);
    return false; // Em caso de erro, assume que são diferentes por segurança
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
  const MAX_RETRIES = 5; // Limite para evitar loops infinitos

  // Continue a iterar quando as tags são efetivamente idênticas
  while (retryCount < MAX_RETRIES) {
    info(`🔍 [CHANGELOG] Tentativa ${retryCount + 1} de gerar changelog${targetSha ? ` a partir de ${targetSha.substring(0, 7)}` : ''}`);

    let commits: any[] = [];

    if (targetSha) {
      const currentSha = sha();

      // Verifica se as tags são efetivamente idênticas
      if (await areTagsEffectivelyIdentical(targetSha, currentSha)) {
        info(`🔍 [CHANGELOG] As tags são efetivamente idênticas: ${targetSha.substring(0, 7)} e ${currentSha.substring(0, 7)}`);

        // Encontra a próxima tag no histórico para continuar a iteração
        const currentTagIndex = tags.findIndex(tag => tag.commit.sha === currentSha);
        const previousTagIndex = tags.findIndex(tag => tag.commit.sha === targetSha);

        // Se ambas as tags estão no histórico e são próximas, continue para a próxima
        if (currentTagIndex >= 0 && previousTagIndex >= 0) {
          const nextTagIndex = Math.max(previousTagIndex, currentTagIndex) + 1;

          if (nextTagIndex < tags.length) {
            targetSha = tags[nextTagIndex].commit.sha;
            info(`🔍 [CHANGELOG] Continuando para a próxima tag: ${tags[nextTagIndex].name} (${targetSha.substring(0, 7)})`);
            retryCount++;
            continue;
          }
        }

        // Se não encontrarmos uma próxima tag, tentamos usar o commit pai
        try {
          const commit = await rest.git.getCommit({
            owner,
            repo,
            commit_sha: targetSha,
          });

          if (commit.data.parents.length > 0) {
            targetSha = commit.data.parents[0].sha;
            info(`🔍 [CHANGELOG] Continuando para o commit pai: ${targetSha.substring(0, 7)}`);
            retryCount++;
            continue;
          }
        } catch (error) {
          info(`🔍 [CHANGELOG] Erro ao obter commit pai: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      info(`🔍 [CHANGELOG] Obtendo commits entre ${targetSha.substring(0, 7)} e ${currentSha.substring(0, 7)}`);

      try {
        // Corrigido: Ajuste para trabalhar com a nova tipagem da resposta
        const compareResult = await rest.repos.compareCommits({
          owner,
          repo,
          base: targetSha,
          head: currentSha,
          per_page: 100,
        });

        // Acessa commits diretamente do objeto de resposta
        commits = compareResult.data.commits;
      } catch (error) {
        // Se falhar com o lastSha, tente com todos os commits
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
      info("🔍 [CHANGELOG] Obtendo todos os commits (nenhum SHA de referência fornecido)");

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

    // Se nenhum commit foi processado, tente novamente com a próxima tag se estivermos em retry mode
    if (processedCommitCount === 0 && retryCount > 0 && retryCount < MAX_RETRIES) {
      // Tenta encontrar uma tag anterior para tentar novamente
      const currentTagIndex = tags.findIndex(tag => tag.commit.sha === targetSha);

      if (currentTagIndex >= 0 && currentTagIndex + 1 < tags.length) {
        targetSha = tags[currentTagIndex + 1].commit.sha;
        info(`🔍 [CHANGELOG] Sem commits processados, tentando com a próxima tag: ${tags[currentTagIndex + 1].name} (${targetSha.substring(0, 7)})`);
        retryCount++;
        continue;
      }
    }

    // Se nenhum commit foi processado, retornar mensagem indicando sem alterações significativas
    if (processedCommitCount === 0 && lastSha) {
      info(`🔍 [CHANGELOG] Nenhuma alteração significativa encontrada para o changelog (todos os commits foram filtrados)`);
      return "## No significant changes in this release\n\n**Full Changelog**: " +
            `${url}/compare/${encodeURIComponent(lastSha)}...${encodeURIComponent(sha())}`;
    }

    info(`🔍 [CHANGELOG] Geração do changelog concluída com método legado`);
    info(`🔍 [CHANGELOG] Commits analisados: ${commitCount}`);
    info(`🔍 [CHANGELOG] Commits incluídos no changelog: ${processedCommitCount}`);

    if (lastSha) {
      info(`🔍 [CHANGELOG] Comparação: De SHA ${lastSha.substring(0, 7)} para ${sha().substring(0, 7)}`);
    } else {
      info(`🔍 [CHANGELOG] Nenhum SHA anterior encontrado para comparação, incluídos todos os commits acessíveis`);
    }

    return formatChangelog(typeGroups, typeMap, defaultType);
  }

  // Se chegamos aqui, atingimos o limite de tentativas
  info(`🔍 [CHANGELOG] Atingido limite de ${MAX_RETRIES} tentativas de gerar um changelog válido`);
  return "## Unable to generate changelog after multiple attempts\n\n" +
         "No significant changes could be found between the compared versions after multiple attempts.";
}
