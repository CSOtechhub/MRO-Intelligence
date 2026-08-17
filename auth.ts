import {createHmac, timingSafeEqual} from 'node:crypto';
import type {NextFunction, Request, Response} from 'express';

const COOKIE_NAME = 'mro_session';
const SESSION_SECONDS = 60 * 60 * 12;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function secret(): string {
  return process.env.SESSION_SECRET || 'local-development-session-secret';
}

function signature(expires: string): string {
  return createHmac('sha256', secret()).update(`owner:${expires}`).digest('base64url');
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.cookie ?? '';
  return Object.fromEntries(header.split(';').flatMap((item) => {
    const index = item.indexOf('=');
    if (index < 0) return [];
    return [[item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())]];
  }));
}

function validSession(request: Request): boolean {
  if (!process.env.OWNER_ACCESS_KEY) return true;
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return false;
  const [expires, provided] = token.split('.');
  if (!expires || !provided || Number(expires) < Date.now()) return false;
  return safeEqual(provided, signature(expires));
}

export function authStatus(request: Request) {
  return {required: Boolean(process.env.OWNER_ACCESS_KEY), authenticated: validSession(request)};
}

export function login(request: Request, response: Response): void {
  const configured = process.env.OWNER_ACCESS_KEY;
  if (!configured) {
    response.json({authenticated: true, required: false});
    return;
  }
  const supplied = typeof request.body?.accessKey === 'string' ? request.body.accessKey : '';
  if (!safeEqual(supplied, configured)) {
    response.status(401).json({error: 'Invalid access key.'});
    return;
  }
  const expires = String(Date.now() + SESSION_SECONDS * 1000);
  const token = `${expires}.${signature(expires)}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure}`);
  response.json({authenticated: true, required: true});
}

export function logout(_request: Request, response: Response): void {
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  response.status(204).end();
}

export function requireUser(request: Request, response: Response, next: NextFunction): void {
  if (validSession(request)) {
    next();
    return;
  }
  response.status(401).json({error: 'Authentication required.'});
}

export function requireIngestAuthority(request: Request, response: Response, next: NextFunction): void {
  const token = process.env.INGEST_TOKEN;
  const supplied = request.header('x-ingest-token') || request.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (token && supplied && safeEqual(supplied, token)) {
    next();
    return;
  }
  requireUser(request, response, next);
}

export function assertProductionSecurity(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = ['OWNER_ACCESS_KEY', 'SESSION_SECRET', 'INGEST_TOKEN'].filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Production security configuration is incomplete: ${missing.join(', ')}`);
}
