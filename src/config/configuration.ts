import * as path from 'path';

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  runtimeMode: process.env.RUNTIME_MODE || null,
  cronEnabled: process.env.CRON_ENABLED ?? null,
  apiUrl: process.env.API_URL || 'http://localhost:3000',
  /** Base pública para ficheiros (sem `/api`). Se vazio, deriva-se de `API_URL`. */
  assetsPublicUrl: process.env.ASSETS_PUBLIC_URL?.replace(/\/$/, '') || null,
  /** Path público dos uploads: `/uploads` (padrão) ou `/api/uploads` se o proxy só encaminhar `/api`. */
  uploadsPublicPrefix:
    (process.env.UPLOADS_PUBLIC_PREFIX || '/uploads').replace(/\/$/, '') ||
    '/uploads',

  database: {
    url: process.env.DATABASE_URL,
  },

  storage: {
    uploadsPath:
      process.env.UPLOADS_PATH || path.join(process.cwd(), 'uploads'),
    /** `r2` força R2; `local` força disco; vazio = R2 se credenciais existirem */
    backend: process.env.STORAGE_BACKEND || null,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-change-in-production',
    expiration: process.env.JWT_EXPIRES_IN || '7d',
  },

  /**
   * Sessão renovável. O access token curto só é emitido quando o cliente
   * envia `sessaoRenovavel`; builds antigos continuam no JWT de `JWT_EXPIRES_IN`.
   */
  session: {
    accessTokenTtlSeconds: parseInt(process.env.ACCESS_TOKEN_TTL_SECONDS || '3600', 10),
    rememberIdleDays: parseInt(process.env.SESSION_REMEMBER_IDLE_DAYS || '90', 10),
    rememberAbsoluteDays: parseInt(process.env.SESSION_REMEMBER_ABSOLUTE_DAYS || '365', 10),
    ephemeralIdleHours: parseInt(process.env.SESSION_EPHEMERAL_IDLE_HOURS || '24', 10),
    ephemeralAbsoluteDays: parseInt(process.env.SESSION_EPHEMERAL_ABSOLUTE_DAYS || '7', 10),
    reuseGraceSeconds: parseInt(process.env.SESSION_REUSE_GRACE_SECONDS || '30', 10),
  },

  company: {
    name: process.env.COMPANY_NAME || 'Yatsunami',
    city: process.env.COMPANY_CITY || 'Curitiba',
    state: process.env.COMPANY_STATE || 'PR',
  },

  mail: {
    host: process.env.MAIL_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.MAIL_PORT || '587', 10),
    user: process.env.MAIL_USER,
    password: process.env.MAIL_PASSWORD,
    fromEmail: process.env.MAIL_FROM_EMAIL || 'nao-responda@yatsunami.com.br',
    fromName: process.env.MAIL_FROM_NAME || 'Yatsunami',
  },

  auth: {
    resetPasswordExpirationMinutes: parseInt(
      process.env.PASSWORD_RESET_EXPIRATION_MINUTES || '15',
      10,
    ),
  },
  googleMapsKey: process.env.GOOGLE_MAPS_KEY,
});
