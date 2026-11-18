import { spawnSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Scripts de shell da VPS, executados de verdade com binários falsos no PATH.
 *
 * Achados do code review 2026-11:
 * - `update-cloudflare-realip.sh` lia as faixas com `while read`, que descarta
 *   a última linha quando a resposta não termina em `\n` — e as listas da
 *   Cloudflare não terminam. A última faixa de cada lista ficava de fora, e o
 *   nginx registrava o IP do edge para quem vinha por ela.
 * - `vps-deploy.sh` documentava `REPO_DIR` mas só lia `VPS_REPO_DIR`.
 */
const RAIZ = path.resolve(__dirname, '..', '..');
const barras = (p: string) => p.replace(/\\/g, '/');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'scripts-deploy-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function bash(script: string, env: Record<string, string>) {
  const r = spawnSync('bash', [barras(script)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
}

describe('update-cloudflare-realip.sh', () => {
  it('inclui a última faixa mesmo sem quebra de linha no fim da resposta', () => {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    // `printf` sem \n final, como a Cloudflare responde.
    writeFileSync(
      path.join(bin, 'curl'),
      [
        '#!/usr/bin/env bash',
        'url="${@: -1}"',
        'case "$url" in',
        '  *ips-v4) printf "173.245.48.0/20\\n103.21.244.0/22" ;;',
        '  *ips-v6) printf "2400:cb00::/32" ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(path.join(bin, 'curl'), 0o755);
    const saidaConf = path.join(tmp, 'cloudflare-realip.conf');

    const r = bash(
      path.join(RAIZ, 'deploy/nginx/update-cloudflare-realip.sh'),
      {
        PATH: `${barras(bin)}:${process.env.PATH ?? ''}`,
        OUT: barras(saidaConf),
        RELOAD: '0',
      },
    );

    expect(r.status).toBe(0);
    const conf = readFileSync(saidaConf, 'utf8');
    expect(conf).toContain('set_real_ip_from 173.245.48.0/20;');
    expect(conf).toContain('set_real_ip_from 103.21.244.0/22;');
    expect(conf).toContain('set_real_ip_from 2400:cb00::/32;');
  });
});

describe('vps-deploy.sh', () => {
  const repoFalso = () => {
    const repo = path.join(tmp, 'repo');
    mkdirSync(repo);
    writeFileSync(
      path.join(repo, 'deploy.sh'),
      '#!/usr/bin/env bash\necho "deploy rodou em $REPO_DIR"\n',
    );
    chmodSync(path.join(repo, 'deploy.sh'), 0o755);
    return barras(repo);
  };

  it('respeita REPO_DIR, como o cabeçalho documenta', () => {
    const repo = repoFalso();

    const r = bash(path.join(RAIZ, 'scripts/vps-deploy.sh'), {
      REPO_DIR: repo,
      VPS_REPO_DIR: '',
    });

    expect(r.status).toBe(0);
    expect(r.saida).toContain(`deploy rodou em ${repo}`);
  });

  it('continua aceitando VPS_REPO_DIR', () => {
    const repo = repoFalso();

    const r = bash(path.join(RAIZ, 'scripts/vps-deploy.sh'), {
      VPS_REPO_DIR: repo,
      REPO_DIR: '',
    });

    expect(r.status).toBe(0);
    expect(r.saida).toContain(`deploy rodou em ${repo}`);
  });
});

/**
 * `deploy.sh` — funções carregadas sem rodar o fluxo principal (tudo antes do
 * `cd "$REPO_DIR"`), com `docker`/`curl` substituídos por funções de shell.
 *
 * Achados do code review 2026-11 cobertos aqui:
 * - o health check usava só `--connect-timeout`: uma API que aceita a conexão
 *   e não responde prendia o `curl` indefinidamente;
 * - o rollback recriava o slot antigo com `:latest`, que o build já tinha
 *   movido para a versão rejeitada;
 * - um deploy interrompido depois de trocar o proxy deixava o arquivo de
 *   estado apontando para o slot errado, e o deploy seguinte removia o slot
 *   que estava servindo.
 *
 * `DEPLOY_SH` permite rodar estes testes contra outra versão do script (ex.:
 * `git show HEAD:deploy.sh`) para confirmar que eles reprovam a antiga.
 */
describe('deploy.sh', () => {
  const script = () => process.env.DEPLOY_SH ?? path.join(RAIZ, 'deploy.sh');

  /** Roda `corpo` com as funções do deploy.sh carregadas e dublês definidos. */
  function comFuncoes(corpo: string, env: Record<string, string> = {}) {
    const funcoes = path.join(tmp, 'funcoes.sh');
    const fonte = readFileSync(script(), 'utf8');
    const fim = fonte.indexOf('\ncd "$REPO_DIR"\n');
    writeFileSync(funcoes, fonte.slice(0, fim));
    const harness = path.join(tmp, 'harness.sh');
    writeFileSync(
      harness,
      [
        'set -euo pipefail',
        `source "${barras(funcoes)}"`,
        'log() { echo "LOG: $*"; }',
        corpo,
      ].join('\n'),
    );
    return bash(harness, {
      REPO_DIR: barras(tmp),
      NGINX_DIR: 'nginx',
      DEPLOY_STATE_FILE: barras(path.join(tmp, 'estado')),
      ...env,
    });
  }

  it('limita a requisição inteira do health check (--max-time)', () => {
    const r = comFuncoes(`
      # api_http_code descarta o stderr do curl; os argumentos vão para arquivo.
      curl() { echo "ARGS: $*" >"$REPO_DIR/curl-args"; echo 200; }
      api_http_code 3071 /api >/dev/null
      cat "$REPO_DIR/curl-args"
    `);

    expect(r.saida).toMatch(/ARGS: .*--max-time \d+/);
  });

  it('rollback recria o slot antigo com a imagem anterior, não com :latest', () => {
    const r = comFuncoes(`
      PREVIOUS_IMAGE_ID="sha256:versao-anterior"
      docker() { [ "$1" = "run" ] && echo "DOCKER RUN: $*"; return 0; }
      prepare_docker_env_file() { :; }
      archive_container_logs() { :; }
      wait_for_api_health() { return 0; }
      write_active_backend_inc() { :; }
      ensure_api_proxy() { :; }
      reload_api_proxy() { :; }
      rollback_blue_green a 3071 b
    `);

    const run =
      r.saida.split('\n').find((l) => l.startsWith('DOCKER RUN:')) ?? '';
    expect(run).toContain('sha256:versao-anterior');
    expect(run).not.toContain('yatsunami_api:latest');
  });

  it('corrige o estado quando o proxy serve o outro slot', () => {
    mkdirSync(path.join(tmp, 'nginx', 'runtime'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'nginx', 'runtime', 'active-upstream.inc'),
      'upstream yatsunami_api_backend {\n  server 127.0.0.1:3072 max_fails=2 fail_timeout=5s;\n}\n',
    );
    writeFileSync(path.join(tmp, 'estado'), 'a\n');

    const r = comFuncoes(`
      docker() { [ "$1" = "ps" ] && printf 'yatsunami_api_a\nyatsunami_api_b\n'; return 0; }
      if declare -F reconcile_active_slot >/dev/null; then reconcile_active_slot; fi
      echo "ATIVO: $(active_slot)"
    `);

    expect(r.saida).toContain('ATIVO: b');
  });

  it('não mexe no estado quando o slot do proxy não está rodando', () => {
    mkdirSync(path.join(tmp, 'nginx', 'runtime'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'nginx', 'runtime', 'active-upstream.inc'),
      'upstream yatsunami_api_backend {\n  server 127.0.0.1:3072 max_fails=2 fail_timeout=5s;\n}\n',
    );
    writeFileSync(path.join(tmp, 'estado'), 'a\n');

    const r = comFuncoes(`
      docker() { [ "$1" = "ps" ] && printf 'yatsunami_api_a\n'; return 0; }
      if declare -F reconcile_active_slot >/dev/null; then reconcile_active_slot; fi
      echo "ATIVO: $(active_slot)"
    `);

    expect(r.saida).toContain('ATIVO: a');
  });

  /**
   * A VPS hospeda outros projetos (taikonnect, draftpro). O `docker image
   * prune -a -f` sem filtro apagava as imagens deles que não estivessem em
   * uso — inclusive a de rollback —, e o `builder prune` zerava o cache de
   * build de todos. Verificado na VPS em 2026-11-18.
   */
  it('a limpeza só toca imagens deste projeto e limita o cache em vez de zerar', () => {
    const r = comFuncoes(`
      docker() { echo "DOCKER: $*"; return 0; }
      limpar_imagens_antigas
    `);

    const linhas = r.saida.split(/\r?\n/);
    const prune = linhas.find((l) => l.includes('image prune')) ?? '';
    expect(prune).toContain('--filter label=');
    const builder = linhas.find((l) => l.includes('builder prune')) ?? '';
    expect(builder).toContain('--keep-storage');
  });

  it('a imagem é construída com o label usado no filtro da limpeza', () => {
    const fonte = readFileSync(script(), 'utf8');

    expect(fonte).toContain('IMAGE_LABEL="${IMAGE_LABEL:-');
    expect(fonte).toContain('docker build -t "$IMAGE_NAME" --label "$IMAGE_LABEL" .');
  });
});
