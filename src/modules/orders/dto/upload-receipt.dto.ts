import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  ESCOLHAS_DO_CLIENTE,
  type EscolhaDoCliente,
} from '../pagamento-diferenca';

/**
 * Campos do multipart de `PATCH /orders/:id/receipt`, além do arquivo.
 *
 * Só a **escolha** do QR viaja; o valor que o comprovante cobre é calculado no
 * servidor (`comprovanteNovo`). Ausente — app antigo — vale `diferenca`.
 */
export class UploadReceiptDto {
  @ApiProperty({
    enum: ESCOLHAS_DO_CLIENTE,
    required: false,
    description:
      'Qual QR foi pago quando há pagamento anterior: a diferença (padrão) ou o total.',
  })
  @IsOptional()
  @IsIn(ESCOLHAS_DO_CLIENTE)
  tipo?: EscolhaDoCliente;
}
