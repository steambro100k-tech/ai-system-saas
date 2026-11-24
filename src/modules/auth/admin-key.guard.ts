import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { getAppEnv } from '../../common/config/env';

@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header('x-admin-key');
    const { ADMIN_KEY } = getAppEnv();

    const expectedBuffer = Buffer.from(ADMIN_KEY);
    const providedBuffer = Buffer.from(provided ?? '');
    const matches =
      expectedBuffer.length > 0 &&
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer);
    if (!ADMIN_KEY || !provided || !matches) {
      throw new UnauthorizedException('Invalid admin key');
    }

    return true;
  }
}
