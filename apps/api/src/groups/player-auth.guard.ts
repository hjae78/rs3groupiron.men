import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { stripBearer } from '../common/bearer-token';
import { PlayerAccessService } from './player-access.service';

export type AuthedPlayerRequest = Request & {
  playerId: string;
  playerAccessToken: string;
  credentialCreatedAt: Date;
};

export function presentedPlayerToken(header: string | undefined): string {
  return stripBearer(header?.trim() ?? '');
}

@Injectable()
export class PlayerAuthGuard implements CanActivate {
  constructor(private readonly access: PlayerAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedPlayerRequest>();
    const token = presentedPlayerToken(req.headers.authorization);
    if (!token) throw new UnauthorizedException('Missing access token');

    const credential = await this.access.validate(token);
    if (!credential) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    req.playerId = credential.playerId;
    req.playerAccessToken = token;
    req.credentialCreatedAt = credential.createdAt;
    return true;
  }
}
