export type BackgroundJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface BackgroundJobRecord<TResult = unknown> {
    id: string;
    name: string;
    status: BackgroundJobStatus;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    error?: string;
    result?: TResult;
}

export interface PdfJobResult {
    buffer: Buffer;
    filename: string;
    contentType: string;
}
