'use strict';

/**
 * Regras de chave da migração de uploads para o R2, compartilhadas entre
 * `scripts/migrate-uploads-to-r2.mjs` e o teste `src/infra/migracao-r2.spec.ts`.
 *
 * Fonte da verdade para o formato da chave: `StorageService.objectKey`, que
 * grava produtos sempre em `produtos/` (e aceita `products/` só como apelido).
 */

/** Chave R2 para um caminho relativo à pasta de uploads. */
function chaveCanonica(relativo) {
    const rel = String(relativo).replace(/\\/g, '/').replace(/^\/+/, '');
    return rel.startsWith('products/') ? `produtos/${rel.slice('products/'.length)}` : rel;
}

/** Chave R2 que corresponde a uma URL guardada no banco, ou `null` se não for de upload. */
function urlParaChave(url, publicBase) {
    if (!url || !String(url).trim()) return null;
    const u = String(url).trim().split('?')[0];

    if (publicBase && u.startsWith(publicBase)) {
        return u.slice(publicBase.length).replace(/^\//, '');
    }

    for (const marker of ['/uploads/', '/api/uploads/']) {
        const idx = u.indexOf(marker);
        if (idx !== -1) {
            return chaveCanonica(u.slice(idx + marker.length));
        }
    }

    return null;
}

/**
 * URL nova para o banco, ou `null` quando não deve mudar: já é do R2, não é de
 * upload, ou — o caso que importa — o objeto **não está no R2** (upload falhou
 * ou o arquivo nunca existiu). Antes a URL era reescrita assim mesmo e o banco
 * passava a apontar para um objeto ausente.
 */
function novaUrl(url, publicBase, chavesNoR2) {
    const chave = urlParaChave(url, publicBase);
    if (!chave) return null;
    const nova = `${publicBase}/${chave}`;
    if (nova === String(url).trim()) return null;
    if (!chavesNoR2.has(chave)) return null;
    return nova;
}

module.exports = { chaveCanonica, urlParaChave, novaUrl };
