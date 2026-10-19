import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim())
    : [];

  const app = await NestFactory.create(AppModule, {
    // Keeps the exact request bytes on req.rawBody — the WhatsApp webhook
    // verifies Meta's X-Hub-Signature-256 HMAC against them.
    rawBody: true,
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-webhook-secret'],
      // Lets the browser read download file names (Excel template, uploaded sheets, WhatsApp media).
      exposedHeaders: ['Content-Disposition'],
      credentials: false,
    },
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const swaggerEnabled = process.env.SWAGGER_ENABLED ? process.env.SWAGGER_ENABLED === 'true' : !isProduction;

  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  // Behind Nginx the client IP arrives in X-Forwarded-For (rate limits and logs
  // need it). TRUST_PROXY = number of proxy hops; defaults to 1 in production.
  const trustProxy = process.env.TRUST_PROXY ?? (isProduction ? '1' : '');
  if (trustProxy) http.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  app.use(
    helmet({
      // Swagger UI needs inline scripts; the JSON API itself serves no HTML.
      contentSecurityPolicy: swaggerEnabled ? false : undefined,
      // Media (WhatsApp images, uploads) is loaded by the frontend on another origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  // The API map is not published in production unless explicitly enabled.
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Tulsi ERP API')
      .setDescription(
        'Multi-tenant ERP/CRM backend for wholesalers: authentication & RBAC, lead ingestion & allocation, employee performance reporting.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);
  logger.log(`CORS enabled for: ${corsOrigins.join(', ') || '(none configured)'}`);
  logger.log(swaggerEnabled ? 'Swagger docs available at /api/docs' : 'Swagger docs disabled');
}

bootstrap();