import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Sanitized } from '../decorators/sanitized.decorator';

export class I18nStringDto {
    @ApiProperty({ example: 'Nome em Português' })
    @Sanitized('plain')
    @IsString()
    @IsNotEmpty()
    'pt-BR': string;

    @ApiProperty({ example: 'Name in Japanese' })
    @Sanitized('plain')
    @IsString()
    @IsNotEmpty()
    'ja-JP': string;
}
