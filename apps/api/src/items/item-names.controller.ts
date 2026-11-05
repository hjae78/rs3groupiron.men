import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sendCached } from '../common/http-cache';
import { ItemNamesService } from './item-names.service';

// main.ts sets a global 'api' prefix, so this must not repeat it.
@Controller('items')
export class ItemNamesController {
  constructor(private readonly items: ItemNamesService) {}

  /**
   * Item id -> display name for the whole game.
   *
   * Unauthenticated and immutable between game updates, so it is sent with a
   * long cache lifetime and an ETag: a returning client revalidates with one
   * 304 instead of re-downloading ~1.3MB.
   */
  @Get('names')
  @Header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  names(@Req() request: Request, @Res() response: Response) {
    this.serve(request, response, this.items.payload);
  }

  /**
   * Items whose icon changes as the stack grows, as
   * `{ id: [[fromQuantity, imageFile], ...] }` plus the base URL to join them
   * to. The icon CDN has no art for the variant ids, so these come from the
   * wiki and are resolved when the catalogue is generated.
   */
  @Get('stacks')
  @Header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  stacks(@Req() request: Request, @Res() response: Response) {
    this.serve(request, response, this.items.stacksPayload);
  }

  /**
   * High/low alchemy as `{ id: [high, low?] }`. Published by the wiki only for
   * traded items, so the rest are derived from the cache value the game bases
   * them on; see tools/build-catalogue.mjs.
   */
  @Get('alch')
  @Header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  alch(@Req() request: Request, @Res() response: Response) {
    this.serve(request, response, this.items.alchPayload);
  }

  private serve(
    request: Request,
    response: Response,
    { body, etag }: { body: string; etag: string },
  ) {
    sendCached(request, response, etag, (res) => res.type('application/json').send(body));
  }
}
