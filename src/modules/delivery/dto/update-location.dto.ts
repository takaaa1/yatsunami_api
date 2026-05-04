import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class UpdateLocationDto {
    @IsNumber()
    formId: number;

    @IsNumber()
    latitude: number;

    @IsNumber()
    longitude: number;

    @IsOptional()
    @IsNumber()
    courierId?: number;

    @IsOptional()
    @Sanitized('plain', 64)
    @IsString()
    userId?: string;
}
