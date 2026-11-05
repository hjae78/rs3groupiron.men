import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { stripBearer } from '../common/bearer-token';
import { adminToken } from '../config/env';

function firstValue(raw: string | string[] | undefined): string {
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
}

export function presentedAdminToken(headers: IncomingHttpHeaders): string {
  const header =
    firstValue(headers['x-admin-token']) || firstValue(headers.authorization);
  return stripBearer(header);
}

export function adminTokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configured = adminToken();
    if (!configured) throw new NotFoundException();

    const req = context.switchToHttp().getRequest<Request>();
    const provided = presentedAdminToken(req.headers);
    if (!provided || !adminTokenMatches(configured, provided)) {
      throw new UnauthorizedException('Invalid admin token');
    }
    return true;
  }
}
