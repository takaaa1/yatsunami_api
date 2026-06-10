export type RuntimeMode = 'long-running' | 'serverless';

export function resolveRuntimeMode(): RuntimeMode {
    const explicit = process.env.RUNTIME_MODE;
    if (explicit === 'long-running' || explicit === 'serverless') {
        return explicit;
    }

    if (
        process.env.VERCEL
        || process.env.VERCEL_ENV
        || process.env.AWS_LAMBDA_FUNCTION_NAME
        || process.env.FUNCTION_NAME
    ) {
        return 'serverless';
    }

    return 'long-running';
}

export function isCronEnabled(): boolean {
    if (process.env.CRON_ENABLED === 'false') return false;
    if (process.env.CRON_ENABLED === 'true') return true;
    return resolveRuntimeMode() === 'long-running';
}

export function isBackgroundJobRuntime(): boolean {
    return resolveRuntimeMode() === 'long-running';
}

export const CRON_LOCK_KEYS = {
    PAYMENT_LOCK_SYNC: 910_001,
    FORM_OPEN_NOTIFICATIONS: 910_002,
    STALE_TRACKING: 910_003,
    NOTIFICATION_PURGE: 910_004,
    BACKGROUND_JOB_PURGE: 910_005,
} as const;
