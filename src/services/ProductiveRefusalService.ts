export type RefusalType =
  | 'extraction_failure'
  | 'retrieval_thin'
  | 'synthesis_cant_ground'
  | 'out_of_scope';

export interface RefusalContext {
  /** Resolved game title when extraction was confident — surfaced in the message. */
  gameTitle?: string;
}

export class ProductiveRefusalService {
  build(type: RefusalType, question: string, context: RefusalContext = {}): string {
    const game = context.gameTitle?.trim() || '';
    switch (type) {
      case 'extraction_failure':
        return `I heard your question, but I couldn't tell which game you mean. Tell me the game title, like "Final Fantasy VII", and I'll answer ${shortQuestion(question)}.`;
      case 'retrieval_thin':
        return game
          ? `I have guides for ${game} but couldn't find a section that answers this. Try rephrasing or naming a specific boss, area, or quest.`
          : `I found only limited guide content for that request, so I don't want to guess. Try asking with a boss, location, or quest name from the game.`;
      case 'synthesis_cant_ground':
        return game
          ? `I found related excerpts in the ${game} guides, but they don't directly answer your question. Try rephrasing or naming a specific scene, area, or quest.`
          : `I found related excerpts, but they don't support a confident answer to your exact question. Rephrase with a specific objective and I can try again with tighter evidence.`;
      case 'out_of_scope':
        return `I can help with GameFAQs guide questions, but not that topic. Ask me about a game, boss, quest, item, or walkthrough step.`;
      default:
        return `I don't have enough guide evidence to answer that confidently.`;
    }
  }
}

function shortQuestion(q: string): string {
  const t = q.trim();
  return t.length <= 80 ? `"${t}"` : `"${t.slice(0, 77)}..."`;
}
