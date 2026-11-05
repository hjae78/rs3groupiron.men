import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { sendCached } from '../common/http-cache';
import { AssetsService, type Asset } from './assets.service';

/**
 * A week rather than a year: the names are stable but the art behind them can
 * be redrawn by a game update, and the catalogues only refresh weekly. The
 * ETag means a revalidation after that is a 304 with no body.
 */
const WEEK = 'public, max-age=604800, stale-while-revalidate=2592000';

// main.ts sets a global 'api' prefix, so these must not repeat it.
@Controller()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /** Quest and achievement icons from the cache, and mirrored stack art. */
  @Get('sprites/:name')
  @Header('Cache-Control', WEEK)
  sprite(
    @Param('name') name: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const asset = this.assets.sprite(name);
    if (!asset) throw new NotFoundException('No such sprite');
    this.send(request, response, asset);
  }

  /** Item icons, proxied and cached because the renderer sends no cache headers. */
  @Get('items/icon/:id')
  @Header('Cache-Control', WEEK)
  async icon(
    @Param('id') id: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const asset = await this.assets.icon(Number(id));
    if (!asset) throw new NotFoundException('No such item icon');
    this.send(request, response, asset);
  }

  private send(request: Request, response: Response, asset: Asset) {
    sendCached(request, response, asset.etag, (res) => res.type('image/png').send(asset.body));
  }
}
