import express, { type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/common/errors.js';

vi.mock('../src/database/client.js', () => ({ db: {} }));
vi.mock('../src/modules/auth/service.js', () => ({ refresh: vi.fn(), authenticate: vi.fn() }));
import { authRoutes } from '../src/modules/auth/routes.js';
import { refresh } from '../src/modules/auth/service.js';

const app = express();
app.use(express.json(), cookieParser());
authRoutes(app);
const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  res.status(error instanceof AppError ? error.status : 500).json({ code: error.code });
};
app.use(errors);
beforeEach(() => vi.mocked(refresh).mockReset());

describe('web refresh cookie boundary', () => {
  it.each([undefined, 'short', 'x'.repeat(201)])(
    'rejects an absent or malformed cookie with 401',
    async (cookie) => {
      const pending = request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', 'http://localhost:3000');
      if (cookie) pending.set('Cookie', `pms_refresh=${cookie}`);
      const response = await pending.send({});
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('SESSION_EXPIRED');
      expect(String(response.headers['set-cookie'])).toContain('pms_refresh=;');
      expect(refresh).not.toHaveBeenCalled();
    },
  );
  it('still requires a trusted Origin before processing the cookie', async () => {
    const response = await request(app).post('/api/v1/auth/refresh').send({});
    expect(response.status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('rotates valid cookies while keeping the replacement refresh token out of JSON', async () => {
    const replacement = 'r'.repeat(64);
    vi.mocked(refresh).mockResolvedValue({
      accessToken: 'access-only',
      refreshToken: replacement,
      sessionId: 'test-session',
      expiresIn: 900,
      refreshExpiresAt: new Date(Date.now() + 60000),
    });
    const token = 't'.repeat(64);
    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', `pms_refresh=${token}`)
      .send({});
    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledWith(token, false);
    expect(response.body.data.accessToken).toBe('access-only');
    expect(response.body.data.refreshToken).toBeUndefined();
    expect(String(response.headers['set-cookie'])).toContain(`pms_refresh=${replacement}`);
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
  });
});
