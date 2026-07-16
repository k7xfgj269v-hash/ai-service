import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { json, text, urlencoded } from 'express';
import { AppModule } from './app.module';
import { parseCorsOrigins, readBoolean } from './config/env.validation';

export async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });
  const configService = app.get(ConfigService);
  const bodyLimit = configService.get<string>('HTTP_BODY_LIMIT', '1mb');

  app.use('/work-weixin/callback', text({
    type: () => true,
    limit: bodyLimit,
  }));

  app.use((req, res, next) => {
    if (req.body !== undefined) return next();
    json({ limit: bodyLimit })(req, res, next);
  });

  app.use((req, res, next) => {
    if (req.body !== undefined) return next();
    urlencoded({ extended: false, limit: bodyLimit })(req, res, next);
  });

  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }));
  app.enableShutdownHooks();

  const allowedOrigins = parseCorsOrigins(
    configService.get<string>('CORS_ORIGINS', ''),
  );
  app.enableCors({
    credentials: true,
    origin: (origin, callback) => {
      callback(null, !origin || allowedOrigins.includes(origin));
    },
  });

  if (readBoolean(configService.get('SWAGGER_ENABLED'), false)) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('企业微信AI客服 - HR专家模式')
      .setDescription('企业微信智能客服API文档')
      .setVersion('1.0')
      .addTag('work-weixin', '企业微信服务')
      .addTag('knowledge-base', '知识库管理')
      .addTag('weixin-knowledge-sync', '企业微信聊天记录同步')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api', app, document);
  }

  const port = configService.get<number>('PORT', 3031);
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`HTTP server listening on port ${port}`);
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    const logger = new Logger('Bootstrap');
    logger.error(error instanceof Error ? error.message : 'Application startup failed');
    process.exitCode = 1;
  });
}
