#!/usr/bin/env node
/**
 * Envia ficheiros de UPLOADS_PATH para R2 e actualiza URLs na base de dados.
 *
 * Pré-requisitos (.env na raiz de yatsunami_api):
 *   DATABASE_URL, UPLOADS_PATH, CLOUDFLARE_S3_URL, CLOUDFLARE_ACCESS_KEY,
 *   CLOUDFLARE_SECRET_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
 *
 * Uso na VPS:
 *   cd /var/www/yatsunami/api
 *   node scripts/test-r2-connection.mjs
 *   node scripts/migrate-uploads-to-r2.mjs              # dry-run
 *   node scripts/migrate-uploads-to-r2.mjs --execute    # aplica
 *
 * Ordem recomendada:
 *   1. dry-run
 *   2. --execute (upload + BD)
 *   3. STORAGE_BACKEND=r2 no .env + FORCE_DEPLOY=true ./deploy.sh (recria os slots)
 *   4. EXPO_PUBLIC_UPLOADS_ORIGIN no app (EAS Update)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { PrismaClient } from '@prisma/client';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Regras de chave compartilhadas com o teste (src/infra/migracao-r2.spec.ts).
const { chaveCanonica, novaUrl } = createRequire(import.meta.url)('./lib/r2-keys.cjs');
const root = join(__dirname, '..');

function loadEnvFile(envPath) {
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        if (process.env[key] !== undefined) continue;
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        process.env[key] = val;
    }
}

loadEnvFile(join(root, '.env'));

const execute = process.argv.includes('--execute');
const dryRun = !execute;

const uploadsRoot = (process.env.UPLOADS_PATH || '/var/www/yatsunami/uploads').replace(/\/+$/, '');
const publicBase = (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
const endpoint = (process.env.CLOUDFLARE_S3_URL ?? '').replace(/\/+$/, '');
const bucket = (process.env.R2_BUCKET ?? 'yatsunami').trim();

if (!publicBase || !endpoint || !process.env.CLOUDFLARE_ACCESS_KEY || !process.env.CLOUDFLARE_SECRET_KEY) {
    console.error('ERRO: defina R2_PUBLIC_BASE_URL e credenciais Cloudflare no .env');
    process.exit(1);
}

const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
        accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY.trim(),
        secretAccessKey: process.env.CLOUDFLARE_SECRET_KEY.trim(),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
});

function contentTypeFromKey(key) {
    const ext = /\.(\w+)$/.exec(key)?.[1]?.toLowerCase() || 'png';
    const map = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        pdf: 'application/pdf',
    };
    return map[ext] || 'image/png';
}

function walkFiles(dir, base = dir) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            out.push(...walkFiles(full, base));
        } else if (st.isFile()) {
            out.push({
                abs: full,
                // Mesma chave que a URL reescrita usa (products/ → produtos/).
                key: chaveCanonica(relative(base, full)),
                size: st.size,
            });
        }
    }
    return out;
}

function publicUrlForKey(key) {
    return `${publicBase}/${key.replace(/^\//, '')}`;
}

async function objectExists(key) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch {
        return false;
    }
}

async function uploadFile(absPath, key) {
    const body = readFileSync(absPath);
    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentTypeFromKey(key),
        }),
    );
}

async function main() {
    console.log(dryRun ? '=== DRY RUN ===' : '=== EXECUTE ===');
    console.log('uploadsRoot:', uploadsRoot);
    console.log('R2 bucket:', bucket);
    console.log('publicBase:', publicBase);
    console.log('');

    if (!existsSync(uploadsRoot)) {
        console.error(`ERRO: pasta de uploads ${uploadsRoot} não existe; nada foi alterado.`);
        process.exit(1);
    }
    const files = walkFiles(uploadsRoot);
    console.log(`Ficheiros no disco: ${files.length}`);

    // Chaves que estão (ou, no dry-run, estariam) no R2. Só URLs destas chaves
    // são reescritas no banco — antes a reescrita ignorava falhas de upload.
    const chavesNoR2 = new Set();

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const f of files) {
        const exists = await objectExists(f.key);
        if (exists) {
            chavesNoR2.add(f.key);
            skipped++;
            if (dryRun) console.log(`[skip R2] ${f.key}`);
            continue;
        }
        if (dryRun) {
            console.log(`[upload] ${f.key} (${f.size} bytes) -> ${publicUrlForKey(f.key)}`);
            chavesNoR2.add(f.key);
            uploaded++;
            continue;
        }
        try {
            await uploadFile(f.abs, f.key);
            console.log(`OK upload ${f.key}`);
            chavesNoR2.add(f.key);
            uploaded++;
        } catch (e) {
            console.error(`FAIL upload ${f.key}:`, e.message);
            failed++;
        }
    }

    console.log(`\nUploads: ${uploaded} novos, ${skipped} já no R2, ${failed} falhas`);
    if (failed > 0 && !dryRun) {
        console.error('ERRO: houve falhas de upload; o banco NÃO foi alterado. Corrija e rode de novo.');
        process.exit(1);
    }

    const prisma = new PrismaClient();
    const stats = { usuario: 0, produto: 0, variedadeProduto: 0, pedidoEncomenda: 0, skipped: 0 };

    async function updateUrl(table, id, field, oldUrl) {
        // null = não é de upload, já é do R2, ou o objeto não está no R2.
        const next = novaUrl(oldUrl, publicBase, chavesNoR2);
        if (!next) {
            stats.skipped++;
            return;
        }
        if (dryRun) {
            console.log(`[BD ${table}#${id}] ${field}`);
            console.log(`  old: ${oldUrl}`);
            console.log(`  new: ${next}`);
            stats[table]++;
            return;
        }
        await prisma[table].update({
            where: { id },
            data: { [field]: next },
        });
        console.log(`[BD ${table}#${id}] ${field} -> ${next}`);
        stats[table]++;
    }

    const usuarios = await prisma.usuario.findMany({
        where: { avatarUrl: { not: null } },
        select: { id: true, avatarUrl: true },
    });
    for (const u of usuarios) {
        await updateUrl('usuario', u.id, 'avatarUrl', u.avatarUrl);
    }

    const produtos = await prisma.produto.findMany({
        where: { imagem: { not: null } },
        select: { id: true, imagem: true },
    });
    for (const p of produtos) {
        await updateUrl('produto', p.id, 'imagem', p.imagem);
    }

    const variedades = await prisma.variedadeProduto.findMany({
        where: { imagem: { not: null } },
        select: { id: true, imagem: true },
    });
    for (const v of variedades) {
        await updateUrl('variedadeProduto', v.id, 'imagem', v.imagem);
    }

    const pedidos = await prisma.pedidoEncomenda.findMany({
        where: { comprovanteUrl: { not: null } },
        select: { id: true, comprovanteUrl: true },
    });
    for (const p of pedidos) {
        await updateUrl('pedidoEncomenda', p.id, 'comprovanteUrl', p.comprovanteUrl);
    }

    await prisma.$disconnect();

    console.log('\nBD actualizada:', stats);
    if (dryRun) {
        console.log('\nNada foi alterado. Corra com --execute para aplicar.');
    } else {
        console.log('\nPróximo passo: STORAGE_BACKEND=r2 no .env e FORCE_DEPLOY=true ./deploy.sh');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
