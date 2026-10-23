import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Tulsi ERP shows no money: no lead value, no product price. The columns stay
 * in the database (nothing is lost, billing may want them later) but these
 * fields never leave the API — whichever endpoint, include or JSON blob a
 * record reaches the response through.
 */
export const HIDDEN_MONEY_FIELDS = new Set(['estimatedValue', 'autoAllotMinValue', 'price', 'costPrice']);

/** A copy of a response body without the hidden money fields, at any depth. Non-plain objects (files, dates) pass through. */
export function stripMoneyFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripMoneyFields) as T;
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!HIDDEN_MONEY_FIELDS.has(key)) out[key] = stripMoneyFields(field);
  }
  return out as T;
}

@Injectable()
export class MoneyFieldsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(stripMoneyFields));
  }
}
