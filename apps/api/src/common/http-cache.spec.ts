import type { Request, Response } from 'express';
import { sendCached } from './http-cache';

function buildResponse() {
  const response = {
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return response;
}

describe('sendCached', () => {
  it('answers a matching if-none-match with a bare 304 and skips send', () => {
    const request = { headers: { 'if-none-match': '"abc"' } } as unknown as Request;
    const response = buildResponse();
    const send = jest.fn();

    sendCached(request, response, '"abc"', send);

    expect(response.status).toHaveBeenCalledWith(304);
    expect(response.set).toHaveBeenCalledWith('ETag', '"abc"');
    expect(response.end).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a 200 with the ETag when the client has no match', () => {
    const request = { headers: {} } as unknown as Request;
    const response = buildResponse();
    const send = jest.fn();

    sendCached(request, response, '"abc"', send);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.set).toHaveBeenCalledWith('ETag', '"abc"');
    expect(send).toHaveBeenCalledWith(response);
  });

  it('sends a 200 when the if-none-match header does not match', () => {
    const request = { headers: { 'if-none-match': '"old"' } } as unknown as Request;
    const response = buildResponse();
    const send = jest.fn();

    sendCached(request, response, '"abc"', send);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith(response);
  });
});
