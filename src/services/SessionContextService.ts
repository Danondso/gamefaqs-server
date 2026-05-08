import type { ConversationTurn } from './GameExtractionService';

export interface SessionContext {
  establishedGameId?: string;
  turns: ConversationTurn[];
  updatedAt: number;
}

export class SessionContextService {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly maxTurns: number;

  constructor(maxTurns: number = 8) {
    this.maxTurns = maxTurns;
  }

  get(sessionId: string): SessionContext {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionContext = { turns: [], updatedAt: Date.now() };
    this.sessions.set(sessionId, created);
    return created;
  }

  appendTurn(sessionId: string, turn: ConversationTurn): void {
    const ctx = this.get(sessionId);
    ctx.turns.push(turn);
    if (ctx.turns.length > this.maxTurns) {
      ctx.turns = ctx.turns.slice(ctx.turns.length - this.maxTurns);
    }
    ctx.updatedAt = Date.now();
  }

  setGame(sessionId: string, gameId?: string): void {
    const ctx = this.get(sessionId);
    ctx.establishedGameId = gameId;
    ctx.updatedAt = Date.now();
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
