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
    
    info(`�� [CHANGELOG] Verificando identidade entre ${baseRef} e ${headRef}`);
    
    // Primeira abordagem: Verificar diretamente a comparação via API
    try {
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
      
      info(`🔍 [CHANGELOG] Resultado da comparação: ahead_by=${compareResult.data.ahead_by}, behind_by=${compareResult.data.behind_by}, files alterados=${compareResult.data.files?.length ?? 'N/A'}, total_commits=${compareResult.data.total_commits}`);
      
    } catch (error) {
      info(`🔍 [CHANGELOG] Erro ao comparar referências via API: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Segunda abordagem: Comparar tree SHAs dos commits
    try {
      // Resolver referências para tags como refs/tags/nome-da-tag
      const getRefOrCommit = async (ref: string) => {
        try {
          // Tentar primeiro como uma ref normal (branch ou tag)
          const refPath = ref.startsWith('refs/') ? ref : `refs/tags/${ref}`;
          return await rest.git.getRef({
            owner,
            repo,
            ref: refPath.replace(/^refs\//, '') // Remover 'refs/' se existir
          });
        } catch (error) {
          try {
            // Tentar como um branch
            if (!ref.includes('/')) {
              return await rest.git.getRef({
                owner,
                repo,
                ref: `heads/${ref}`
              });
            }
          } catch (branchError) {
            // Continua para a próxima abordagem
          }
          
          // Se ambas falharem, tentar como SHA direto
          return await rest.git.getCommit({
            owner,
            repo,
            commit_sha: ref
          });
        }
      };
      
      // Obter refs para base e head
      const baseCommitRef = await getRefOrCommit(baseRef);
      const headCommitRef = await getRefOrCommit(headRef);
      
      // Extrair o SHA real do commit
      const baseCommitSha = 'object' in baseCommitRef.data ? baseCommitRef.data.object.sha : baseRef;
      const headCommitSha = 'object' in headCommitRef.data ? headCommitRef.data.object.sha : headRef;
      
      info(`🔍 [CHANGELOG] SHA resolvidos: base=${baseCommitSha.substring(0, 7)}, head=${headCommitSha.substring(0, 7)}`);
      
      // Obter os dados dos commits
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
      
      // Comparar os tree SHAs
      const baseTreeSha = baseCommit.data.tree.sha;
      const headTreeSha = headCommit.data.tree.sha;
      
      const treesIdentical = baseTreeSha === headTreeSha;
      
      if (treesIdentical) {
        info(`🔍 [CHANGELOG] Os tree SHAs são idênticos: ${baseTreeSha} = ${headTreeSha}`);
        return true;
      } else {
        info(`🔍 [CHANGELOG] Os tree SHAs são diferentes: ${baseTreeSha} ≠ ${headTreeSha}`);
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
  const shouldIncludePRLinks = includePRLinks();
  const shouldIncludeCommitLinks = includeCommitLinks();
  const shouldMentionAuthors = mentionAuthors();
  const shouldUseGithubAutolink = useGithubAutolink();

  info(`🔍 [CHANGELOG] Gerando changelog`);
  info(`�� [CHANGELOG] SHA atual: ${sha()}`);
  info(`🔍 [CHANGELOG] SHA anterior (lastSha): ${lastSha || "none"}`);

  const typeGroups: TypeGroupI[] = [];
  let commitCount = 0;
  let processedCommitCount = 0;
  
  // Retorna changelog vazio se os SHAs são idênticos
  if (lastSha === sha()) {
    info(`🔍 [CHANGELOG] SHAs atual e anterior são idênticos, não há alterações para incluir`);
    return "## No changes in this release\n\n**No changes detected between these releases.**";
  }

  // Se temos um SHA anterior, primeiro verificamos se as releases são efetivamente idênticas
  if (lastSha) {
    info(`🔍 [CHANGELOG] Comparando referências: ${lastSha} e ${sha()}`);
    
    // Verificar se os dois commits representam o mesmo estado de código
    const areIdentical = await areTagsEffectivelyIdentical(lastSha, sha());
    if (areIdentical) {
      info(`🔍 [CHANGELOG] Releases são efetivamente idênticas em conteúdo, não há alterações para incluir`);
      return "## No changes in this release\n\n**No changes detected between these releases.**";
    }

    info(`🔍 [CHANGELOG] Usando API de comparação para obter commits entre ${lastSha.substring(0, 7)} e ${sha().substring(0, 7)}`);

    try {
      // Verificar se há alterações entre os dois SHAs
      const compareResult = await rest.repos.compareCommits({
        owner,
        repo,
        base: lastSha,
        head: sha(),
      });
      
      info(`🔍 [CHANGELOG] Status da API de comparação: ${compareResult.status}, total de commits: ${compareResult.data.total_commits}, ahead by: ${compareResult.data.ahead_by}, behind by: ${compareResult.data.behind_by}`);
      
      // Se a API diz que estamos à frente, mas não há commits ou arquivos modificados, não há mudanças significativas
      if ((compareResult.data.ahead_by > 0 && compareResult.data.total_commits === 0) || 
          (compareResult.data.files && compareResult.data.files.length === 0)) {
        info(`🔍 [CHANGELOG] Resposta inconsistente da API ou sem alterações em arquivos`);
        return "## No changes in this release\n\n**No significant changes detected between these releases.**";
      }
      
      // Se não há commits à frente, não há alterações para incluir no changelog
      if (compareResult.data.ahead_by === 0) {
        info(`🔍 [CHANGELOG] Não há commits à frente do SHA base, não há alterações para incluir no changelog`);
        return "## No changes in this release\n\n**No changes detected between these releases.**";
      }
      
      if (compareResult.data.commits.length === 0) {
        info(`🔍 [CHANGELOG] API de comparação não retornou commits entre os SHAs, mesmo com ahead_by > 0`);
        warning(`API de comparação reportou ${compareResult.data.ahead_by} commits à frente mas retornou 0 commits. Verifique a resposta da API do GitHub.`);
        return "## No significant changes detected\n\n**Full Changelog**: " + 
               `${url}/compare/${encodeURIComponent(lastSha)}...${encodeURIComponent(sha())}`;
      }

      info(`🔍 [CHANGELOG] Encontrados ${compareResult.data.commits.length} commits entre os dois SHAs`);

      // Rastrear commits que devem ser excluídos do changelog
      let mergeCommits = 0;
      let emptyDescriptionCommits = 0;
      let ignoredCommits = 0;

      // Processar cada commit da comparação
      for (const commit of compareResult.data.commits) {
        commitCount++;

        const message = commit.commit.message.split("\n")[0];
        const commitSHA = commit.sha.substring(0, 7);
        debug(`commit message -> ${message}`);
        
        // Pular commits de merge
        if (message.startsWith("Merge ") || message.includes(" into ") || message.includes("//github.com")) {
          info(`🔍 [CHANGELOG] Commit ${commitSHA} ignorado: Commit de merge`);
          mergeCommits++;
          continue;
        }

        let { type, scope, description, pr, flag, breaking } = parseCommitMessage(message);

        if (!description) {
          info(`🔍 [CHANGELOG] Commit ${commitSHA} ignorado: Sem descrição`);
          emptyDescriptionCommits++;
          continue;
        }

        description = trim(description);
        flag = trim(flag);

        if (flag === "ignore") {
          info(`🔍 [CHANGELOG] Commit ${commitSHA} ignorado: Marcado como ignore`);
          ignoredCommits++;
          continue;
        }

        processedCommitCount++;

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        type = typeMap[trim(type ?? "")] ?? defaultType;

        // Log para cada 10º commit para evitar logs excessivos
        if (processedCommitCount % 10 === 0 || processedCommitCount < 5) {
          info(`🔍 [CHANGELOG] Processando commit ${commitSHA}: ${type}${scope ? `(${scope})` : ""}: ${description}`);
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

      // Log de estatísticas sobre commits ignorados
      info(`🔍 [CHANGELOG] Commits de merge ignorados: ${mergeCommits}`);
      info(`🔍 [CHANGELOG] Commits com descrições vazias ignorados: ${emptyDescriptionCommits}`);
      info(`🔍 [CHANGELOG] Commits marcados como ignorados: ${ignoredCommits}`);
      
      // Se nenhum commit foi processado, retornar mensagem indicando sem alterações significativas
      if (processedCommitCount === 0) {
        info(`🔍 [CHANGELOG] Nenhuma alteração significativa encontrada para o changelog (todos os commits foram filtrados)`);
        return "## No significant changes in this release\n\n**Full Changelog**: " + 
               `${url}/compare/${encodeURIComponent(lastSha)}...${encodeURIComponent(sha())}`;
      }

      info(`🔍 [CHANGELOG] API de comparação usada com sucesso para gerar o changelog`);
      info(`🔍 [CHANGELOG] Geração do changelog concluída`);
      info(`🔍 [CHANGELOG] Commits analisados: ${commitCount}`);
      info(`🔍 [CHANGELOG] Commits incluídos no changelog: ${processedCommitCount}`);
      info(`🔍 [CHANGELOG] Comparação: De SHA ${lastSha.substring(0, 7)} para ${sha().substring(0, 7)}`);
      
      return formatChangelog(typeGroups, typeMap, defaultType);
    } catch (error) {
      info(`🔍 [CHANGELOG] Erro ao usar API de comparação: ${error instanceof Error ? error.message : String(error)}`);
      info(`🔍 [CHANGELOG] Recorrendo ao método de listagem de commits legado`);
    }
  }

  // Método legado ou fallback se compareCommits falhar ou lastSha não for fornecido
  info(`🔍 [CHANGELOG] Usando método legado para buscar commits`);
  
  const iterator = paginate.iterator(
    rest.repos.listCommits,
    {
      per_page: 100,
      sha     : sha(),
      owner,
      repo,
    },
  );

  info(`🔍 [CHANGELOG] Buscando commits entre SHA atual e lastSha`);

  paginator: for await (const { data } of iterator) {
    for (const commit of data) {
      commitCount++;

      if (lastSha && commit.sha === lastSha) {
        info(`🔍 [CHANGELOG] Encontrado commit lastSha (${lastSha.substring(0, 7)}), interrompendo processamento`);
        break paginator;
      }

      const message = commit.commit.message.split("\n")[0];
      debug(`commit message -> ${message}`);
      
      // Pular commits de merge
      if (message.startsWith("Merge ") || message.includes(" into ") || message.includes("//github.com")) {
        info(`🔍 [CHANGELOG] Commit ${commit.sha.substring(0, 7)} ignorado: Commit de merge`);
        continue;
      }

      let { type, scope, description, pr, flag, breaking } = parseCommitMessage(message);

      if (!description) {
        info(`🔍 [CHANGELOG] Commit ${commit.sha.substring(0, 7)} ignorado: Sem descrição`);
        continue;
      }

      description = trim(description);

      flag = trim(flag);

      if (flag === "ignore") {
        info(`🔍 [CHANGELOG] Commit ${commit.sha.substring(0, 7)} ignorado: Marcado como ignore`);
        continue;
      }

      processedCommitCount++;

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      type = typeMap[trim(type ?? "")] ?? defaultType;

      // Log para cada 10º commit para evitar logs excessivos
      if (processedCommitCount % 10 === 0 || processedCommitCount < 5) {
        info(`🔍 [CHANGELOG] Processando commit ${commit.sha.substring(0, 7)}: ${type}${scope ? `(${scope})` : ""}: ${description}`);
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
