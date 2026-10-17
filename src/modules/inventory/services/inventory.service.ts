import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Readable } from 'stream';
import { CellValue, Workbook, Worksheet } from 'exceljs';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { AdjustStockDto, CreateProductDto, PRODUCT_CATEGORIES, PRODUCT_UNITS, ProductQueryDto, UpdateProductDto } from '../dto/product.dto';

export const MAX_PRODUCT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

/** Excel columns, in template order. `aliases` are other header spellings we accept. */
const COLUMNS = [
  { key: 'name', header: 'Product Name', required: true, aliases: ['name', 'product', 'item', 'item name'], example: 'Century Club Prime BWP 18mm' },
  { key: 'sku', header: 'SKU', aliases: ['code', 'item code', 'product code'], example: 'CEN-BWP-18' },
  { key: 'category', header: 'Category', aliases: ['type'], example: 'PLYWOOD' },
  { key: 'brand', header: 'Brand', aliases: ['make', 'company'], example: 'Century' },
  { key: 'grade', header: 'Grade', aliases: [], example: 'BWP' },
  { key: 'thickness', header: 'Thickness', aliases: ['thick'], example: '18mm' },
  { key: 'size', header: 'Size', aliases: ['dimension', 'dimensions'], example: '8x4 ft' },
  { key: 'unit', header: 'Unit', aliases: ['uom'], example: 'SHEET' },
  { key: 'price', header: 'Price (₹)', aliases: ['price', 'rate', 'selling price', 'mrp'], example: 3650 },
  { key: 'costPrice', header: 'Cost Price (₹)', aliases: ['cost', 'cost price', 'purchase price'], example: 3100 },
  { key: 'stock', header: 'Stock', aliases: ['qty', 'quantity', 'opening stock', 'stock qty'], example: 120 },
  { key: 'reorderLevel', header: 'Reorder Level', aliases: ['reorder', 'min stock', 'minimum stock'], example: 20 },
  { key: 'description', header: 'Description', aliases: ['notes', 'remarks'], example: 'Boiling water proof, 25-year warranty' },
] as const;

type ColumnKey = (typeof COLUMNS)[number]['key'];
const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export interface ImportIssue {
  row: number;
  message: string;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- read ----------

  async list(actor: AuthenticatedUser, q: ProductQueryDto) {
    const where: Prisma.ProductWhereInput = { orgId: actor.orgId, deletedAt: null };
    if (q.category) where.category = q.category;
    if (q.search) {
      where.OR = ['name', 'sku', 'brand'].map((f) => ({ [f]: { contains: q.search, mode: 'insensitive' } }));
    }
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 50, 500);

    if (q.lowStock === 'true') {
      // Column-to-column comparison isn't expressible in Prisma's where — filter in memory (catalogues are small).
      const all = await this.prisma.product.findMany({ where, orderBy: { stock: 'asc' } });
      const low = all.filter((p) => p.stock <= p.reorderLevel);
      return { items: low.slice((page - 1) * pageSize, page * pageSize), total: low.length, page, pageSize };
    }

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.product.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async summary(actor: AuthenticatedUser) {
    const products = await this.prisma.product.findMany({
      where: { orgId: actor.orgId, deletedAt: null },
      select: { category: true, stock: true, reorderLevel: true, price: true, isActive: true },
    });
    const byCategory: Record<string, { products: number; units: number; value: number }> = {};
    let units = 0;
    let value = 0;
    let lowStock = 0;
    let outOfStock = 0;
    for (const p of products) {
      const v = Number(p.price) * p.stock;
      units += p.stock;
      value += v;
      if (p.stock === 0) outOfStock++;
      else if (p.stock <= p.reorderLevel) lowStock++;
      const c = (byCategory[p.category] ??= { products: 0, units: 0, value: 0 });
      c.products++;
      c.units += p.stock;
      c.value += v;
    }
    return { totalProducts: products.length, totalUnits: units, stockValue: Math.round(value), lowStock, outOfStock, byCategory };
  }

  async get(actor: AuthenticatedUser, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, orgId: actor.orgId, deletedAt: null },
      include: { movements: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  // ---------- write ----------

  async create(actor: AuthenticatedUser, dto: CreateProductDto) {
    await this.assertSkuFree(actor.orgId, dto.sku);
    const stock = dto.stock ?? 0;
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: { ...this.data(dto), stock, orgId: actor.orgId, createdById: actor.userId } });
      if (stock > 0) {
        await tx.stockMovement.create({ data: { orgId: actor.orgId, productId: product.id, change: stock, balanceAfter: stock, reason: 'CREATED', userId: actor.userId } });
      }
      return product;
    });
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateProductDto) {
    await this.get(actor, id);
    if (dto.sku) await this.assertSkuFree(actor.orgId, dto.sku, id);
    const { stock: _ignored, ...rest } = dto;
    return this.prisma.product.update({ where: { id }, data: { ...this.data(rest), ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) } });
  }

  async adjustStock(actor: AuthenticatedUser, id: string, dto: AdjustStockDto) {
    if (dto.change === 0) throw new BadRequestException('Change must not be zero');
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id, orgId: actor.orgId, deletedAt: null } });
      if (!product) throw new NotFoundException('Product not found');
      const balance = product.stock + dto.change;
      if (balance < 0) throw new BadRequestException(`Only ${product.stock} ${product.unit.toLowerCase()}(s) in stock`);
      await tx.stockMovement.create({
        data: { orgId: actor.orgId, productId: id, change: dto.change, balanceAfter: balance, reason: dto.reason, note: dto.note, userId: actor.userId },
      });
      return tx.product.update({ where: { id }, data: { stock: balance } });
    });
  }

  async remove(actor: AuthenticatedUser, id: string) {
    await this.get(actor, id);
    // Free the SKU so it can be reused by a new product.
    await this.prisma.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, sku: null } });
    return { message: 'Product deleted', id };
  }

  // ---------- Excel ----------

  async buildTemplate(): Promise<Buffer> {
    const wb = new Workbook();
    const sheet = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(14, c.header.length + 4) }));
    sheet.getRow(1).font = { bold: true };
    COLUMNS.forEach((c, i) => {
      if ('required' in c && c.required) sheet.getRow(1).getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } };
    });
    sheet.getColumn('sku').numFmt = '@';

    const help = wb.addWorksheet('Instructions');
    help.columns = [
      { header: 'Column', key: 'header', width: 18 },
      { header: 'Example', key: 'example', width: 32 },
    ];
    help.getRow(1).font = { bold: true };
    COLUMNS.forEach((c) => help.addRow({ header: c.header, example: c.example }));
    help.addRow({});
    help.addRow({ header: 'Category', example: PRODUCT_CATEGORIES.join(', ') });
    help.addRow({ header: 'Unit', example: PRODUCT_UNITS.join(', ') });
    help.addRow({ header: 'Note', example: 'Only "Product Name" is required. A row whose SKU already exists updates that product (price, details and stock).' });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async importFile(actor: AuthenticatedUser, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Choose an .xlsx or .csv file to upload');
    if (file.size > MAX_PRODUCT_FILE_BYTES) throw new BadRequestException('The file is larger than 5 MB');
    const ext = (file.originalname.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    if (!['.xlsx', '.csv'].includes(ext)) throw new BadRequestException('Only .xlsx and .csv files are supported');

    const rows = await this.readRows(file.buffer, ext);
    if (!rows.length) throw new BadRequestException('The sheet has no product rows under the header');
    if (rows.length > MAX_ROWS) throw new BadRequestException(`Up to ${MAX_ROWS} products per file`);

    const issues: ImportIssue[] = [];
    let created = 0;
    let updated = 0;
    const seenSkus = new Set<string>();

    for (const { row, values } of rows) {
      const name = this.text(values.name);
      if (!name) {
        issues.push({ row, message: 'Product Name is empty — row skipped' });
        continue;
      }
      const sku = this.text(values.sku) || undefined;
      if (sku) {
        if (seenSkus.has(sku.toLowerCase())) {
          issues.push({ row, message: `SKU ${sku} repeats an earlier row — row skipped` });
          continue;
        }
        seenSkus.add(sku.toLowerCase());
      }
      const category = this.pick(values.category, PRODUCT_CATEGORIES, 'PLYWOOD', row, 'Category', issues);
      const unit = this.pick(values.unit, PRODUCT_UNITS, 'SHEET', row, 'Unit', issues);
      const data = {
        name,
        category,
        unit,
        brand: this.text(values.brand) || null,
        grade: this.text(values.grade) || null,
        thickness: this.text(values.thickness) || null,
        size: this.text(values.size) || null,
        description: this.text(values.description) || null,
        price: this.num(values.price, row, 'Price', issues) ?? 0,
        costPrice: this.num(values.costPrice, row, 'Cost Price', issues),
        reorderLevel: Math.round(this.num(values.reorderLevel, row, 'Reorder Level', issues) ?? 0),
      };
      const stock = Math.max(0, Math.round(this.num(values.stock, row, 'Stock', issues) ?? 0));

      try {
        const existing = sku ? await this.prisma.product.findFirst({ where: { orgId: actor.orgId, sku, deletedAt: null } }) : null;
        await this.prisma.$transaction(async (tx) => {
          if (existing) {
            await tx.product.update({ where: { id: existing.id }, data: { ...data, stock } });
            const change = stock - existing.stock;
            if (change !== 0) {
              await tx.stockMovement.create({ data: { orgId: actor.orgId, productId: existing.id, change, balanceAfter: stock, reason: 'IMPORT', userId: actor.userId } });
            }
          } else {
            const p = await tx.product.create({ data: { ...data, sku, stock, orgId: actor.orgId, createdById: actor.userId } });
            if (stock > 0) {
              await tx.stockMovement.create({ data: { orgId: actor.orgId, productId: p.id, change: stock, balanceAfter: stock, reason: 'IMPORT', userId: actor.userId } });
            }
          }
        });
        if (existing) updated++;
        else created++;
      } catch (e) {
        issues.push({ row, message: `Could not save: ${(e as Error).message.split('\n').pop()}` });
      }
    }
    return { fileName: file.originalname, totalRows: rows.length, created, updated, failed: rows.length - created - updated, issues };
  }

  // ---------- helpers ----------

  private data(dto: Partial<CreateProductDto>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined || k === 'stock') continue;
      out[k] = typeof v === 'string' ? v.trim() : v;
    }
    return out as Prisma.ProductUncheckedCreateInput;
  }

  private async assertSkuFree(orgId: string, sku?: string, exceptId?: string) {
    if (!sku) return;
    const clash = await this.prisma.product.findFirst({ where: { orgId, sku, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (clash) throw new BadRequestException(`SKU ${sku} is already used by "${clash.name}"`);
  }

  private async readRows(buffer: Buffer, ext: string): Promise<{ row: number; values: Partial<Record<ColumnKey, CellValue>> }[]> {
    const wb = new Workbook();
    let sheet: Worksheet | undefined;
    try {
      if (ext === '.csv') sheet = await wb.csv.read(Readable.from(buffer), { map: (v: unknown) => v });
      else {
        await wb.xlsx.load(buffer as unknown as ArrayBuffer);
        sheet = wb.worksheets[0];
      }
    } catch {
      throw new BadRequestException('This file couldn’t be read as a spreadsheet');
    }
    if (!sheet) throw new BadRequestException('The file has no sheets');

    // Find the header row (first 10 rows) by matching the "Product Name" column.
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const mapping = new Map<number, ColumnKey>();
      sheet.getRow(r).eachCell((cell, col) => {
        const h = norm(this.text(cell.value));
        const c = COLUMNS.find((x) => norm(x.header) === h || x.aliases.some((a) => norm(a) === h));
        if (c) mapping.set(col, c.key);
      });
      if (![...mapping.values()].includes('name')) continue;
      const rows: { row: number; values: Partial<Record<ColumnKey, CellValue>> }[] = [];
      for (let i = r + 1; i <= sheet.rowCount; i++) {
        const values: Partial<Record<ColumnKey, CellValue>> = {};
        let any = false;
        mapping.forEach((key, col) => {
          const v = sheet!.getRow(i).getCell(col).value;
          if (v !== null && v !== undefined && this.text(v) !== '') any = true;
          values[key] = v;
        });
        if (any) rows.push({ row: i, values });
      }
      return rows;
    }
    throw new BadRequestException('Couldn’t find a header row with a "Product Name" column — download the template to see the columns');
  }

  private text(v: CellValue | undefined): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      if ('richText' in v) return v.richText.map((t) => t.text).join('').trim();
      if ('text' in v) return String(v.text).trim();
      if ('result' in v) return String(v.result ?? '').trim();
      if (v instanceof Date) return v.toISOString().slice(0, 10);
    }
    return String(v).trim();
  }

  private num(v: CellValue | undefined, row: number, label: string, issues: ImportIssue[]): number | undefined {
    const t = this.text(v).replace(/[₹,\s]/g, '');
    if (!t) return undefined;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) {
      issues.push({ row, message: `${label} "${this.text(v)}" is not a number — left empty` });
      return undefined;
    }
    return n;
  }

  private pick<T extends string>(v: CellValue | undefined, allowed: readonly T[], fallback: T, row: number, label: string, issues: ImportIssue[]): T {
    const t = this.text(v).toUpperCase().replace(/[\s-]+/g, '_');
    if (!t) return fallback;
    const hit = allowed.find((a) => a === t || a === t.replace(/S$/, ''));
    if (!hit) issues.push({ row, message: `${label} "${this.text(v)}" unknown — saved as ${fallback}` });
    return hit ?? fallback;
  }
}
