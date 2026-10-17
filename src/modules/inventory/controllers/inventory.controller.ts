import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { AuthenticatedUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AdjustStockDto, CreateProductDto, DeleteProductDto, ProductQueryDto, UpdateProductDto } from '../dto/product.dto';
import { InventoryService, MAX_PRODUCT_FILE_BYTES } from '../services/inventory.service';

/** Everyone in the org can see the catalogue; Admin, Manager and Warehouse staff manage it. */
const READ = [Role.ADMIN, Role.MANAGER, Role.CALLER, Role.DELIVERY_PARTNER, Role.WAREHOUSE_STAFF];
const WRITE = [Role.ADMIN, Role.MANAGER, Role.WAREHOUSE_STAFF];

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('products')
  @Roles(...READ)
  @ApiOperation({ summary: 'List products (search, category, lowStock, paging)' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: ProductQueryDto) {
    return this.inventory.list(actor, query);
  }

  @Get('summary')
  @Roles(...READ)
  @ApiOperation({ summary: 'Totals: products, units, stock value, low / out of stock, per category' })
  summary(@CurrentUser() actor: AuthenticatedUser) {
    return this.inventory.summary(actor);
  }

  @Get('import/template')
  @Roles(...WRITE)
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @Header('Content-Disposition', 'attachment; filename="product-upload-template.xlsx"')
  @ApiOperation({ summary: 'Download the Excel template for uploading products' })
  async template() {
    return new StreamableFile(await this.inventory.buildTemplate());
  }

  @Post('import')
  @Roles(...WRITE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PRODUCT_FILE_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Upload products from .xlsx / .csv — new SKUs are created, existing SKUs updated' })
  import(@CurrentUser() actor: AuthenticatedUser, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.inventory.importFile(actor, file);
  }

  @Get('products/:id')
  @Roles(...READ)
  @ApiOperation({ summary: 'One product with its last 20 stock movements' })
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.inventory.get(actor, id);
  }

  @Post('products')
  @Roles(...WRITE)
  @ApiOperation({ summary: 'Add a product (optional opening stock)' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateProductDto) {
    return this.inventory.create(actor, dto);
  }

  @Patch('products/:id')
  @Roles(...WRITE)
  @ApiOperation({ summary: 'Edit product details (stock changes go through /stock)' })
  update(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.inventory.update(actor, id, dto);
  }

  @Patch('products/:id/stock')
  @Roles(...WRITE)
  @ApiOperation({ summary: 'Add or remove stock with a reason (recorded as a stock movement)' })
  adjust(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() dto: AdjustStockDto) {
    return this.inventory.adjustStock(actor, id, dto);
  }

  @Delete('products/:id')
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Soft-delete a product — body { "confirmation": "delete" }' })
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() _dto: DeleteProductDto) {
    return this.inventory.remove(actor, id);
  }
}
