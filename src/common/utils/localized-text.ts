/**
 * Leitura de colunas JSON traduzíveis (`{ "pt-BR": "...", "ja-JP": "..." }`).
 *
 * O Prisma devolve `JsonValue` nessas colunas, então indexar por idioma
 * diretamente vira acesso `any`. Estas funções fazem a checagem em runtime,
 * que é o modelo correto para dados vindos de uma coluna JSON.
 */

/** Idiomas suportados, na ordem de preferência ao resolver um texto. */
const LANGUAGE_PRIORITY = ['pt-BR', 'ja-JP'] as const;

/**
 * Resolve o texto de um campo traduzível.
 *
 * Aceita string simples (formato legado), mapa de idiomas ou nulo.
 * Devolve `fallback` quando não há texto utilizável.
 */
export function readLocalizedText(value: unknown, fallback = ''): string {
    if (typeof value === 'string') return value || fallback;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return fallback;
    }

    const map = value as Record<string, unknown>;
    for (const lang of LANGUAGE_PRIORITY) {
        const text = map[lang];
        if (typeof text === 'string' && text) return text;
    }

    const first = Object.values(map).find(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
    return first ?? fallback;
}
