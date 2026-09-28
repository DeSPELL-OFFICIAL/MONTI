import { EventEmitter } from 'node:events';

/**
 * 웹훅 핸들러(`onRequest`)를 직접 부를 때 세우는 가짜 Express 응답.
 * firebase-functions 는 `res.on('finish')` 로 호출이 끝나기를 기다리고 cors 는 헤더를 직접
 * 읽고 지운다 — EventEmitter 상속과 헤더 장부가 없으면 핸들러가 영영 끝나지 않는다.
 */
export class FakeRes extends EventEmitter {
  statusCode = 200;
  body: unknown;
  private readonly sent: Record<string, unknown> = {};
  setHeader(key: string, value: unknown): void {
    this.sent[key.toLowerCase()] = value;
  }
  getHeader(key: string): unknown {
    return this.sent[key.toLowerCase()];
  }
  removeHeader(key: string): void {
    delete this.sent[key.toLowerCase()];
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  send(body?: unknown): this {
    this.body = body;
    this.emit('finish');
    return this;
  }
  end(body?: unknown): this {
    if (body !== undefined) this.body = body;
    this.emit('finish');
    return this;
  }
}
