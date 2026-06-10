import {
    Controller,
    Get,
    NotFoundException,
    Param,
    Res,
    UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Roles } from '../decorators';
import { RolesGuard } from '../guards/roles.guard';
import { BackgroundJobService } from './background-job.service';
import { PdfJobResult } from './background-job.types';

@ApiTags('background-jobs')
@Controller('background-jobs')
export class BackgroundJobController {
    constructor(private readonly backgroundJobService: BackgroundJobService) {}

    @Get(':jobId')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Consultar status de job assíncrono' })
    getJobStatus(@Param('jobId') jobId: string) {
        const job = this.backgroundJobService.getJobOrThrow(jobId);
        return this.backgroundJobService.toPublicStatus(job);
    }

    @Get(':jobId/download')
    @ApiBearerAuth('JWT')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('admin')
    @ApiOperation({ summary: 'Baixar resultado de job concluído (ex.: PDF)' })
    downloadJobResult(@Param('jobId') jobId: string, @Res() res: Response) {
        const job = this.backgroundJobService.getJobOrThrow<PdfJobResult>(jobId);

        if (job.status === 'failed') {
            throw new NotFoundException(job.error || 'Job failed');
        }

        if (job.status !== 'completed' || !job.result?.buffer) {
            throw new NotFoundException('Job ainda não concluído');
        }

        const { buffer, filename, contentType } = job.result;

        res.set({
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename=${filename}`,
            'Content-Length': buffer.length,
        });

        res.end(buffer);
    }
}
