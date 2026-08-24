import { PartialType } from '@nestjs/swagger';
import { CreateOrderFormDto } from './create-order-form.dto';

export class UpdateOrderFormDto extends PartialType(CreateOrderFormDto) {}
