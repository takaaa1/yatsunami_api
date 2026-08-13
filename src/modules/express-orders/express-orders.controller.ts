import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../common/types/authenticated-request';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateExpressOrderDto } from './dto/create-express-order.dto';
import { ToggleEnableDto } from './dto/toggle-enable.dto';
import { UpdateExpressStatusDto } from './dto/update-express-status.dto';
import { ExpressOrdersService } from './express-orders.service';

@ApiTags('express-orders')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('express-orders')
export class ExpressOrdersController {
  constructor(private readonly expressOrdersService: ExpressOrdersService) { }

  @Get('status')
  @ApiOperation({ summary: 'Check if user is enabled for express orders' })
  checkStatus(@Req() req: AuthenticatedRequest) {
    return this.expressOrdersService.checkStatus(req.user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new express order' })
  create(@Req() req: AuthenticatedRequest, @Body() createExpressOrderDto: CreateExpressOrderDto) {
    return this.expressOrdersService.create(req.user.id, createExpressOrderDto);
  }

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'List all express orders (Admin)' })
  findAll(
    @Query('status') status?: string,
    @Query('skip') skip?: number,
    @Query('take') take?: number,
  ) {
    return this.expressOrdersService.findAll(status, Number(skip) || 0, Number(take) || 10);
  }

  @Get('my')
  @ApiOperation({ summary: 'List my express orders' })
  findMyOrders(
    @Req() req: AuthenticatedRequest,
    @Query('skip') skip?: number,
    @Query('take') take?: number,
  ) {
    return this.expressOrdersService.findMyOrders(req.user.id, Number(skip) || 0, Number(take) || 10);
  }

  @Get('clients')
  @Roles('admin')
  @ApiOperation({ summary: 'List all clients (Admin)' })
  findAllClients() {
    return this.expressOrdersService.findAllClients();
  }

  @Get('products')
  @ApiOperation({ summary: 'List all products with express status' })
  findAllProducts() {
    return this.expressOrdersService.findAllProducts();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get express order details' })
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
    return this.expressOrdersService.findOne(id, req.user);
  }

  @Patch(':id/status')
  @Roles('admin')
  @ApiOperation({ summary: 'Update express order status' })
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateExpressStatusDto: UpdateExpressStatusDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expressOrdersService.updateStatus(id, updateExpressStatusDto.status, req.user.id, updateExpressStatusDto.observacoes);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel own express order' })
  cancelOrder(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
    return this.expressOrdersService.cancelOrder(id, req.user.id);
  }

  @Post('toggle-client/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Toggle client express access' })
  toggleClient(@Param('id') id: string, @Body() toggleDto: ToggleEnableDto) {
    return this.expressOrdersService.toggleClient(id, toggleDto.habilitado);
  }

  @Post('toggle-product/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Toggle product express availability' })
  toggleProduct(@Param('id', ParseIntPipe) id: number, @Body() toggleDto: ToggleEnableDto) {
    return this.expressOrdersService.toggleProduct(id, toggleDto.habilitado);
  }

  @Post('toggle-variety/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Toggle variety express availability' })
  toggleVariety(@Param('id', ParseIntPipe) id: number, @Body() toggleDto: ToggleEnableDto) {
    return this.expressOrdersService.toggleVariety(id, toggleDto.habilitado);
  }
}
