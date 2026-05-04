import { IsString, IsOptional, IsBoolean, IsIn, IsInt, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class UserFilterDto {
    @ApiPropertyOptional({ example: 'João', description: 'Busca por nome ou e-mail' })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    search?: string;

    @ApiPropertyOptional({ example: 'user', enum: ['admin', 'user'], description: 'Filtrar por role' })
    @IsOptional()
    @Sanitized('plain')
    @IsString()
    @IsIn(['admin', 'user'])
    role?: string;

    @ApiPropertyOptional({ example: true, description: 'Filtrar por status ativo/inativo' })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    })
    ativo?: boolean;

    @ApiPropertyOptional({ example: false, description: 'Excluídos são ocultos por padrão. Use true para listar somente usuários excluídos.' })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    })
    excluido?: boolean;

    @ApiPropertyOptional({ example: 0, description: 'Número de registros a pular' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    skip?: number;

    @ApiPropertyOptional({ example: 10, description: 'Número de registros a retornar' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    take?: number;
}
