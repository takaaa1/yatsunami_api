/**
 * Formato do JSON gravado em `ConfiguracaoFormularios.enderecoRestaurante`.
 *
 * O Prisma devolve `JsonValue`, então sem tipo explícito qualquer acesso a
 * `.logradouro`/`.cidade` vira `any`.
 */
export interface RestaurantAddress {
    /** Endereço já montado numa linha só; quando presente, tem prioridade. */
    endereco?: string;
    logradouro?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    estado?: string;
    cep?: string;
}

/** Lê o campo JSON de configuração como endereço, ou `null` se ausente/malformado. */
export function asRestaurantAddress(value: unknown): RestaurantAddress | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RestaurantAddress;
}

/**
 * Endereço de ORIGEM da rota (inclui complemento).
 *
 * Atenção: difere de `formatRestaurantDestination` — a origem usa
 * `logradouro, numero - complemento - bairro, cidade-estado`. As duas formas
 * convivem no código desde antes desta tipagem e foram preservadas como estavam.
 */
export function formatRestaurantOrigin(rest: RestaurantAddress | null): string {
    if (!rest) return '';
    if (rest.endereco) return rest.endereco;
    if (!rest.logradouro) return '';
    return (
        `${rest.logradouro}` +
        `${rest.numero ? `, ${rest.numero}` : ''}` +
        `${rest.complemento ? ` - ${rest.complemento}` : ''}` +
        ` - ${rest.bairro}, ${rest.cidade}-${rest.estado}`
    );
}

/** Endereço de DESTINO final da rota (volta ao restaurante) — sem complemento. */
export function formatRestaurantDestination(rest: RestaurantAddress | null): string {
    if (!rest) return '';
    if (rest.endereco) return rest.endereco;
    if (!rest.logradouro) return '';
    return (
        `${rest.logradouro}` +
        `${rest.numero ? `, ${rest.numero}` : ''}` +
        `${rest.bairro ? `, ${rest.bairro}` : ''}` +
        `, ${rest.cidade}-${rest.estado}`
    );
}
