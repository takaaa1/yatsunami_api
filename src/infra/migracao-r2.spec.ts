import path from 'path';

/**
 * Regras de chave do `scripts/migrate-uploads-to-r2.mjs` (code review 2026-11).
 *
 * 1. Upload e reescrita de URL usavam mapeamentos diferentes: o arquivo local
 *    `products/a.png` subia com a chave `products/a.png`, e a URL no banco
 *    virava `.../produtos/a.png` — objeto que não existia.
 * 2. A URL era reescrita mesmo quando o upload tinha falhado (ou a pasta de
 *    uploads nem existia): o banco passava a apontar para nada.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- módulo CommonJS compartilhado com o script .mjs
const regras = require(
  path.resolve(__dirname, '../../scripts/lib/r2-keys.cjs'),
) as {
  chaveCanonica: (relativo: string) => string;
  urlParaChave: (
    url: string | null | undefined,
    publicBase: string,
  ) => string | null;
  novaUrl: (
    url: string | null | undefined,
    publicBase: string,
    chavesNoR2: Set<string>,
  ) => string | null;
};

const BASE = 'https://cdn.exemplo.com';

describe('chave canônica', () => {
  it('arquivo local em products/ sobe como produtos/, como o storage.service grava', () => {
    expect(regras.chaveCanonica('products/a.png')).toBe('produtos/a.png');
  });

  it('demais pastas ficam como estão', () => {
    expect(regras.chaveCanonica('produtos/a.png')).toBe('produtos/a.png');
    expect(regras.chaveCanonica('avatars/u.jpg')).toBe('avatars/u.jpg');
  });

  it('a chave do upload e a da URL reescrita coincidem', () => {
    const doArquivo = regras.chaveCanonica('products/a.png');
    const daUrl = regras.urlParaChave(
      'https://api.exemplo.com/uploads/products/a.png',
      BASE,
    );
    expect(daUrl).toBe(doArquivo);
  });
});

describe('reescrita de URL', () => {
  it('reescreve quando o objeto está no R2', () => {
    const noR2 = new Set(['produtos/a.png']);
    expect(
      regras.novaUrl(
        'https://api.exemplo.com/uploads/products/a.png',
        BASE,
        noR2,
      ),
    ).toBe(`${BASE}/produtos/a.png`);
  });

  it('não reescreve quando o objeto não está no R2 (upload falhou ou não existia)', () => {
    expect(
      regras.novaUrl(
        'https://api.exemplo.com/uploads/products/a.png',
        BASE,
        new Set(),
      ),
    ).toBeNull();
  });

  it('não mexe em URL que já é do R2 ou que não é de upload', () => {
    const noR2 = new Set(['produtos/a.png']);
    expect(regras.novaUrl(`${BASE}/produtos/a.png`, BASE, noR2)).toBeNull();
    expect(regras.novaUrl('https://outro.site/x.png', BASE, noR2)).toBeNull();
  });
});
