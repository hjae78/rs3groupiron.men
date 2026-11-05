import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sendCached } from '../common/http-cache';
import { CatalogueService } from './catalogue.service';
import { ItemNamesService } from './item-names.service';

const DAY = 'public, max-age=86400, stale-while-revalidate=604800';

// main.ts sets a global 'api' prefix, so this must not repeat it.
@Controller('catalogue')
export class CatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly items: ItemNamesService,
  ) {}

  /** What each catalogue holds and which cache revision it came from. */
  @Get()
  summary() {
    return {
      items: {
        count: this.items.count,
        revision: this.items.cacheRevision,
        updated: this.items.updatedAt,
      },
      catalogues: this.catalogue.describe(),
    };
  }

  @Get('npcs')
  @Header('Cache-Control', DAY)
  npcs(@Req() request: Request, @Res() response: Response) {
    this.serve(request, response, 'npc-names');
  }

  @Get('achievements')
  @Header('Cache-Control', DAY)
  achievements(@Req() request: Request, @Res() response: Response) {
    this.serve(request, response, 'achievements');
  }

  private serve(request: Request, response: Response, key: string) {
    const { body, etag } = this.catalogue.payload(key);
    sendCached(request, response, etag, (res) => res.type('application/json').send(body));
  }
}
