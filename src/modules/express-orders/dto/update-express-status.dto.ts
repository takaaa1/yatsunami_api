import { IsEnum, IsOptional, IsString } from 'class-validator';
import { Sanitized } from '../../../common/decorators/sanitized.decorator';

export class UpdateExpressStatusDto {
  @Sanitized('plain')
  @IsEnum(['pendente', 'confirmado', 'entregue', 'cancelado'])
  status: string;

  @IsOptional()
  @Sanitized('multiline')
  @IsString()
  observacoes?: string;
}
