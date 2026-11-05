import type { Request, Response } from 'express';

/**
 * Answers an if-none-match revalidation with a bare 304, otherwise lets
 * `send` write the 200 body. Callers set Cache-Control themselves beforehand.
 */
export function sendCached(
  request: Request,
  response: Response,
  etag: string,
  send: (response: Response) => void,
): void {
  if (request.headers['if-none-match'] === etag) {
    response.status(304).set('ETag', etag).end();
    return;
  }
  response.status(200).set('ETag', etag);
  send(response);
}
