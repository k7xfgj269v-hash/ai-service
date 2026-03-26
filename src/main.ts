import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  const bodyParser = require('body-parser');

  // 企业微信回调路由用文本解析器（接收 XML）
  app.use('/work-weixin/callback', bodyParser.text({
    type: () => true,
    limit: '10mb'
  }));

  // 其他路由用 JSON 解析器
  app.use((req, res, next) => {
    if (req.body !== undefined) return next();
    bodyParser.json()(req, res, next);
  });

  app.use((req, res, next) => {
    if (req.body !== undefined) return next();
    bodyParser.urlencoded({ extended: true })(req, res, next);
  });

  app.useGlobalPipes(new ValidationPipe());
  app.enableCors();

  const config = new DocumentBuilder()
    .setTitle('企业微信AI客服 - HR专家模式')
    .setDescription('企业微信智能客服API文档')
    .setVersion('1.0')
    .addTag('work-weixin', '企业微信服务')
    .addTag('knowledge-base', '知识库管理')
    .addTag('weixin-knowledge-sync', '企业微信聊天记录同步')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT || 3031;
  await app.listen(port);

  console.log(`\n应用启动成功！`);
  console.log(`HTTP: http://localhost:${port}`);
  console.log(`API文档: http://localhost:${port}/api`);
  console.log(`回调地址: https://${process.env.PUBLIC_DOMAIN}/work-weixin/callback (nginx 反代)\n`);
}

bootstrap();
