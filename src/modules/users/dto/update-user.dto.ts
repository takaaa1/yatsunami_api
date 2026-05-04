import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class UpdateUserDto {
    @ApiPropertyOptional({ example: 'João Silva' })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    nome?: string;

    @ApiPropertyOptional({ example: '41999998888' })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    telefone?: string | null;

    @ApiPropertyOptional({ example: '123.456.789-00' })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    cpfCnpj?: string | null;

    @ApiPropertyOptional({ example: 'Observações do cliente' })
    @IsOptional()
    @Sanitized('multiline')
    @IsString()
    observacoes?: string | null;

    @ApiPropertyOptional({ example: 'admin', enum: ['admin', 'user'] })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    @IsIn(['admin', 'user'])
    role?: string;

    @ApiPropertyOptional({ example: 'dark', enum: ['light', 'dark', 'system'] })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    tema?: string;

    @ApiPropertyOptional({ example: 'pt-BR', enum: ['pt-BR', 'ja-JP'] })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    idioma?: string;

    @ApiPropertyOptional({ description: 'Array de endereços JSON' })
    @IsOptional()
    @Transform(({ value }) => {
        if (typeof value === 'string') {
            try { return JSON.parse(value); } catch { return value; }
        }
        return value;
    })
    endereco?: any;

    @ApiPropertyOptional({ example: true })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => value === 'true' || value === true)
    receberNotificacoes?: boolean;

    @ApiPropertyOptional({ example: true, description: 'Usuário ativo ou desativado' })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => value === 'true' || value === true)
    ativo?: boolean;
}
