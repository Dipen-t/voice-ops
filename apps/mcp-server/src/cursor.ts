import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { epoch, ToolFailure } from './contracts.js';

const payload = z.object({ binding: z.string(), row: epoch, field: z.string().max(256) }).strict();
export class Cursors {
  private readonly key = randomBytes(32);
  encode(binding: string, row: string, field = ''): string {
    const body = Buffer.from(JSON.stringify({ binding, row, field })).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }
  decode(token: string | undefined, binding: string): { row: string; field: string } {
    if (!token) return { row: '-1', field: '' };
    try {
      const [body, signature, extra] = token.split('.');
      if (!body || !signature || extra || token.length > 2048) throw new Error();
      const actual = Buffer.from(signature, 'base64url');
      const expected = createHmac('sha256', this.key).update(body).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const value = payload.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
      if (value.binding !== binding) throw new Error();
      return { row: value.row, field: value.field };
    } catch { throw new ToolFailure('INVALID_CURSOR'); }
  }
}
