/**
 * Errors that are the caller's fault.
 *
 * `describeError` in app.ts already reads `statusCode` / `code` / `message` off
 * whatever was thrown, so throwing one of these from anywhere in a service
 * produces the right status and a Thai message on the tablet — no reply object
 * has to be threaded through the business logic.
 *
 * Anything that is NOT one of these becomes a 500 with a generic message and
 * the real detail only in the log. That default is deliberate: a stack trace
 * must never appear on a screen the customer can see.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message: string): HttpError =>
  new HttpError(400, code, message);

export const unauthorized = (message = 'กรุณาเข้าสู่ระบบ'): HttpError =>
  new HttpError(401, 'UNAUTHORIZED', message);

export const forbidden = (message: string): HttpError => new HttpError(403, 'FORBIDDEN', message);

export const notFound = (code: string, message: string): HttpError =>
  new HttpError(404, code, message);

/** State conflict: paying a bill that is already paid, voiding a fired line... */
export const conflict = (code: string, message: string): HttpError =>
  new HttpError(409, code, message);

export const tooManyRequests = (code: string, message: string): HttpError =>
  new HttpError(429, code, message);
