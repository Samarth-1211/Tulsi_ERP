import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { phoneticKey } from '../common/utils/phonetic-key.util';

/** Models with a `searchKey` column and the fields it is built from (see phonetic-key.util). */
const SEARCH_KEY_SOURCES: Record<string, string[]> = {
  Lead: ['name'],
  Product: ['name', 'brand'],
  Organization: ['name'],
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    this.$use((params, next) => this.maintainSearchKey(params, next));
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL via Prisma');
    this.backfillSearchKeys().catch((e) => this.logger.warn(`searchKey backfill failed: ${e?.message ?? e}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Keeps `searchKey` in sync on every write, so English searches find Hindi names and vice versa.
   * The key is written in the same statement as the change. An update that touches only some
   * source fields reads the others first — a plain read never waits on row locks, so this is safe
   * inside interactive transactions. A partial updateMany (none today) clears the key instead,
   * and the startup backfill rebuilds it.
   */
  private async maintainSearchKey(params: Prisma.MiddlewareParams, next: (p: Prisma.MiddlewareParams) => Promise<any>) {
    const fields = params.model && SEARCH_KEY_SOURCES[params.model];
    if (!fields) return next(params);
    const keyOf = (d: any) => phoneticKey(...fields.map((f) => d?.[f]));
    // `undefined` means "leave unchanged" in Prisma, so it does not count as touching a field.
    const has = (d: any, f: string) => d?.[f] !== undefined;
    const touches = (d: any) => fields.some((f) => has(d, f));
    const isFull = (d: any) => fields.every((f) => has(d, f));
    const value = (v: any) => (v && typeof v === 'object' && 'set' in v ? v.set : v);
    const merged = async (where: any, data: any) => {
      const current = await this.delegate(params.model!).findUnique({ where, select: Object.fromEntries(fields.map((f) => [f, true])) });
      // Not visible outside an open transaction (created in it): leave it to the backfill.
      if (!current) return null;
      return keyOf({ ...current, ...Object.fromEntries(fields.filter((f) => has(data, f)).map((f) => [f, value(data[f])])) });
    };
    const args = params.args ?? {};

    switch (params.action) {
      case 'create':
        args.data = { ...args.data, searchKey: keyOf(args.data) };
        break;
      case 'createMany':
        args.data = Array.isArray(args.data) ? args.data.map((d: any) => ({ ...d, searchKey: keyOf(d) })) : { ...args.data, searchKey: keyOf(args.data) };
        break;
      case 'upsert':
        args.create = { ...args.create, searchKey: keyOf(args.create) };
        if (touches(args.update)) args.update = { ...args.update, searchKey: await merged(args.where, args.update) };
        break;
      case 'update':
        if (touches(args.data)) args.data = { ...args.data, searchKey: isFull(args.data) ? keyOf(Object.fromEntries(fields.map((f) => [f, value(args.data[f])]))) : await merged(args.where, args.data) };
        break;
      case 'updateMany':
        if (touches(args.data)) args.data = { ...args.data, searchKey: isFull(args.data) ? keyOf(args.data) : null };
        break;
    }
    return next(params);
  }

  private delegate(model: string): any {
    return (this as any)[model[0].toLowerCase() + model.slice(1)];
  }

  /** Fills `searchKey` for rows written before the column existed (idempotent, runs at startup). */
  private async backfillSearchKeys(): Promise<void> {
    for (const [model, fields] of Object.entries(SEARCH_KEY_SOURCES)) {
      const delegate = this.delegate(model);
      const select = Object.fromEntries([['id', true], ...fields.map((f) => [f, true])]);
      let total = 0;
      for (;;) {
        const rows = await delegate.findMany({ where: { searchKey: null }, select, take: 500 });
        if (!rows.length) break;
        // phoneticKey returns '' for an empty name, so every row leaves the null set.
        await this.$transaction(rows.map((r: any) => delegate.update({ where: { id: r.id }, data: { searchKey: phoneticKey(...fields.map((f) => r[f])) } })));
        total += rows.length;
      }
      if (total) this.logger.log(`searchKey backfilled for ${total} ${model} row(s)`);
    }
  }
}
