import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class UpdateLocationDto {
    @Type(() => Number)
    @IsNumber()
    formId: number;

    @Type(() => Number)
    @IsNumber()
    latitude: number;

    @Type(() => Number)
    @IsNumber()
    longitude: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    courierId?: number;

    @IsOptional()
    @Sanitized('plain', 64)
    @IsString()
    userId?: string;
}
