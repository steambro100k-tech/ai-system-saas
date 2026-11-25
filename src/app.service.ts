import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { conf } from './core';
import { isProd } from "./infrastructure/helper/is-production";
import helmet from "helmet";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

export class App {
  static readonly prod = isProd();
  static readonly HOST = '0.0.0.0';
  static readonly api = 'api/v1';

  static async main() {
    const app = await NestFactory.create(AppModule);

    app.use(helmet({
      contentSecurityPolicy: this.prod ? undefined : false,
    }));

    app.enableCors({
      origin: this.prod
        ? conf.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
        : true,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'x-telegram-init-data'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    });

    app.setGlobalPrefix(this.api);

    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true
    }));

    if (!this.prod){
      const config = new DocumentBuilder()  
        .setTitle('Savdo API')
        .setDescription('Barbershop AI Admin & Barber Mini App')
        .setVersion('1.0')
        .addCookieAuth()
        .build();

      const document = SwaggerModule.createDocument(app, config);
      SwaggerModule.setup('docs', app, document);
    }

    await app.listen(conf.PORT, this.HOST);

    console.log(`\nServer is running: http://${this.HOST}:${conf.PORT}/${this.api}`);

    if (!this.prod){
      console.log(`Swagger is running: http://${this.HOST}:${conf.PORT}/docs`)
    }
  }
}
