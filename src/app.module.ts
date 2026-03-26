import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ServeStaticModule } from "@nestjs/serve-static";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { join } from "path";
import { WorkWeixinModule } from "./work-weixin/work-weixin.module";
import { KnowledgeBaseModule } from "./knowledge-base/knowledge-base.module";
import { AiServiceModule } from "./ai-service/ai.module";
import { ChatModule } from "./chat/chat.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000,   // 1分钟窗口（毫秒）
      limit: 20,    // 每分钟最多20次请求
    }]),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, "..", "public"),
      serveRoot: "/",
    }),
    WorkWeixinModule,
    KnowledgeBaseModule,
    AiServiceModule,
    ChatModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
