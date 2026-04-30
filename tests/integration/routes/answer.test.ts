import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, TestAppResult } from '../../helpers/testApp';
import type { AnswerService, AnswerResult } from '../../../src/services/AnswerService';

interface Stub {
  service: AnswerService;
  setHandler: (h: (q: string) => Promise<AnswerResult>) => void;
  callCount: () => number;
}

function createStubAnswerService(defaultResult: AnswerResult): Stub {
  let calls = 0;
  let handler: (q: string) => Promise<AnswerResult> = async () => defaultResult;
  return {
    service: {
      answer: async (question: string) => {
        calls++;
        return handler(question);
      },
    } as unknown as AnswerService,
    setHandler: (h) => { handler = h; },
    callCount: () => calls,
  };
}

const happyResult: AnswerResult = {
  answer: 'Save by visiting an inn. [1]',
  no_answer: false,
  citations: [
    {
      guide_id: 'g1',
      guide_title: 'Sample Guide',
      chunk_id: 'c1',
      chunk_index: 0,
      excerpt: 'You can save your game at inns and save points.',
      score: 0.5,
    },
  ],
  timing_ms: { embed: 50, retrieve: 30, synthesize: 800, total: 880 },
};

describe('POST /api/guides/answer', () => {
  let testApp: TestAppResult;
  let stub: Stub;

  beforeEach(() => {
    stub = createStubAnswerService(happyResult);
    testApp = createTestApp({ answerService: stub.service });
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it('returns 400 when question is missing', async () => {
    const res = await request(testApp.app).post('/api/guides/answer').send({}).expect(400);
    expect(res.body.error).toMatch(/question is required/i);
  });

  it('returns 400 when question is empty string', async () => {
    const res = await request(testApp.app)
      .post('/api/guides/answer')
      .send({ question: '   ' })
      .expect(400);
    expect(res.body.error).toMatch(/question is required/i);
  });

  it('returns 400 when question exceeds 1000 chars', async () => {
    const oversize = 'a'.repeat(1001);
    const res = await request(testApp.app)
      .post('/api/guides/answer')
      .send({ question: oversize })
      .expect(400);
    expect(res.body.error).toMatch(/1000 characters/);
  });

  it('returns 400 when top_k is out of bounds', async () => {
    for (const bad of [0, 21, -1, 1.5, 'five']) {
      const res = await request(testApp.app)
        .post('/api/guides/answer')
        .send({ question: 'how do I save?', top_k: bad })
        .expect(400);
      expect(res.body.error).toMatch(/top_k/);
    }
  });

  it('returns 400 when game_id is not a string', async () => {
    const res = await request(testApp.app)
      .post('/api/guides/answer')
      .send({ question: 'q', game_id: 42 })
      .expect(400);
    expect(res.body.error).toMatch(/game_id/);
  });

  it('returns 503 when AnswerService throws an embedding error', async () => {
    stub.setHandler(async () => {
      throw new Error('Embedding API error: 500 Internal Server Error');
    });
    const res = await request(testApp.app)
      .post('/api/guides/answer')
      .send({ question: 'how do I save?' })
      .expect(503);
    expect(res.body.error).toMatch(/Embedding service unavailable/);
  });

  it('returns 503 when AnswerService throws a synthesis error', async () => {
    stub.setHandler(async () => {
      throw new Error('Synthesis API error: 500 Internal Server Error');
    });
    const res = await request(testApp.app)
      .post('/api/guides/answer')
      .send({ question: 'how do I save?' })
      .expect(503);
    expect(res.body.error).toMatch(/Synthesis service unavailable/);
  });

  it('returns the AnswerService result on the happy path', async () => {
    const res = await request(testApp.app)
      .post('/api/guides/answer')
      .send({ question: 'how do I save?' })
      .expect(200);

    expect(res.body.answer).toBe(happyResult.answer);
    expect(res.body.no_answer).toBe(false);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0].chunk_id).toBe('c1');
    expect(res.body.timing_ms).toEqual(happyResult.timing_ms);
    expect(stub.callCount()).toBe(1);
  });

  it('rate-limits: the 11th call from the same IP within the window returns 429', async () => {
    // Default config.answerRateLimitPerMin = 10. Use the same X-Forwarded-For
    // for all calls so trust proxy treats them as one IP.
    const ip = '203.0.113.42';
    for (let i = 0; i < 10; i++) {
      await request(testApp.app)
        .post('/api/guides/answer')
        .set('X-Forwarded-For', ip)
        .send({ question: `q${i}` })
        .expect(200);
    }
    const res = await request(testApp.app)
      .post('/api/guides/answer')
      .set('X-Forwarded-For', ip)
      .send({ question: 'one too many' })
      .expect(429);
    expect(res.body.error).toMatch(/Rate limit exceeded/);
    expect(typeof res.body.retryAfter).toBe('number');
  });
});
