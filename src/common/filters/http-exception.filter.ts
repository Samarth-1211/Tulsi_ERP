import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

interface ErrorReply {
  status: number;
  error: string;
  message: string | string[];
}

/** Friendly names for unique-constraint columns in P2002 messages. */
const FIELD_LABELS: Record<string, string> = { email: 'email', sku: 'SKU', slug: 'name', phone: 'phone number' };

/**
 * Maps known database errors to a 4xx the client can act on. Anything else
 * becomes a generic 500 — the real message (file paths, SQL, Prisma
 * internals) is only logged, never sent to the browser.
 */
export function toErrorReply(exception: unknown): ErrorReply {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const responseBody = exception.getResponse();
    if (typeof responseBody === 'string') {
      return { status, error: exception.name, message: responseBody };
    }
    const body = responseBody as Record<string, unknown>;
    return {
      status,
      error: (body.error as string) ?? exception.name,
      message: (body.message as string | string[]) ?? exception.message,
    };
  }

  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    switch (exception.code) {
      case 'P2002': {
        const target = exception.meta?.target;
        const fields = (Array.isArray(target) ? target : typeof target === 'string' ? [target] : [])
          .filter((f) => f !== 'orgId')
          .map((f) => FIELD_LABELS[String(f)] ?? String(f));
        const what = fields.length ? `this ${fields.join(' + ')}` : 'these details';
        return { status: HttpStatus.CONFLICT, error: 'Conflict', message: `A record with ${what} already exists.` };
      }
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, error: 'Not Found', message: 'The record was not found.' };
      case 'P2003':
        return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'A linked record does not exist.' };
      case 'P2000':
        return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'A value is too long.' };
      case 'P2020':
        return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'A number is too large.' };
    }
  }

  if (exception instanceof Prisma.PrismaClientUnknownRequestError && /22003|out of range|overflow/i.test(exception.message)) {
    return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'A number is too large.' };
  }

  if (exception instanceof Prisma.PrismaClientValidationError) {
    return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'The request contains invalid data.' };
  }

  // body-parser / multer errors carry their own 4xx (413 too large, 400 bad JSON).
  const httpish = exception as { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown; name?: unknown };
  const status = Number(httpish?.statusCode ?? httpish?.status);
  if (status >= 400 && status < 500 && httpish.expose !== false) {
    return {
      status,
      error: typeof httpish.name === 'string' ? httpish.name : 'Bad Request',
      message: status === HttpStatus.PAYLOAD_TOO_LARGE ? 'The request is too large.' : String(httpish.message ?? 'Bad request'),
    };
  }

  return { status: HttpStatus.INTERNAL_SERVER_ERROR, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, error, message } = toErrorReply(exception);
    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`${request.method} ${request.url} — ${err.message}`, err.stack);
    }

    response.status(status).json({
      statusCode: status,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
