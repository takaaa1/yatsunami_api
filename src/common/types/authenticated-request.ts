import type { Request } from 'express';

/**
 * Usuário anexado à request pelo guard JWT (Passport).
 *
 * Sem este tipo, todo `@Req() req` deixa `req.user` como `any` e qualquer
 * leitura de `req.user.id` vira acesso não verificado.
 */
export interface AuthenticatedUser {
    id: string;
    email?: string;
    role?: string;
}

/** Request já autenticada — use com `@Req() req: AuthenticatedRequest`. */
export interface AuthenticatedRequest extends Request {
    user: AuthenticatedUser;
}
