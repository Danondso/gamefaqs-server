import type { Guide } from '../../src/types';

export const sampleGuideData = {
  basic: {
    title: 'Super Mario Bros. Walkthrough',
    content: 'This is a complete walkthrough for Super Mario Bros. World 1-1: Run to the right...',
    format: 'txt' as const,
    file_path: '/guides/nes/super-mario-bros/walkthrough.txt',
  },
  withMetadata: {
    title: 'Final Fantasy VII Boss Guide',
    content: 'Complete boss guide for FF7. Includes strategies for all boss encounters.',
    format: 'txt' as const,
    file_path: '/guides/ps1/ff7/boss-guide.txt',
    metadata: JSON.stringify({
      platform: 'PlayStation',
      author: 'GameExpert',
      tags: ['boss', 'strategy', 'rpg'],
    }),
  },
  html: {
    title: 'Zelda HTML Guide',
    content: '<html><body><h1>Legend of Zelda</h1><p>The adventure begins...</p></body></html>',
    format: 'html' as const,
    file_path: '/guides/nes/zelda/guide.html',
  },
  markdown: {
    title: 'Pokemon Red/Blue Pokedex',
    content: '# Pokemon Guide\n\n## Bulbasaur\n- Type: Grass/Poison\n- Location: Starter',
    format: 'md' as const,
    file_path: '/guides/gb/pokemon/pokedex.md',
  },
  withGameId: (gameId: string) => ({
    title: 'Game-Specific Guide',
    content: 'This guide is linked to a game.',
    format: 'txt' as const,
    file_path: '/guides/linked/guide.txt',
    game_id: gameId,
  }),
  withPosition: {
    title: 'Reading Progress Guide',
    content: 'Long guide content here...',
    format: 'txt' as const,
    file_path: '/guides/test/progress.txt',
    last_read_position: 500,
  },
};

export const searchableGuides = [
  {
    title: 'Walkthrough Guide',
    content: 'Complete walkthrough with all secrets and hidden items.',
    format: 'txt' as const,
    file_path: '/guides/test/walkthrough.txt',
    metadata: JSON.stringify({ tags: ['walkthrough', 'complete'] }),
  },
  {
    title: 'Boss Strategy',
    content: 'Strategies for defeating all bosses in the game.',
    format: 'txt' as const,
    file_path: '/guides/test/boss.txt',
    metadata: JSON.stringify({ tags: ['boss', 'strategy'] }),
  },
  {
    title: 'Collectibles List',
    content: 'Find all hidden collectibles and achievements.',
    format: 'txt' as const,
    file_path: '/guides/test/collectibles.txt',
    metadata: JSON.stringify({ tags: ['collectibles', 'achievements'] }),
  },
  {
    title: 'FAQ and Tips',
    content: 'Frequently asked questions and helpful tips for beginners.',
    format: 'txt' as const,
    file_path: '/guides/test/faq.txt',
    metadata: JSON.stringify({ tags: ['faq', 'tips', 'beginners'] }),
  },
];

export function createManyGuides(count: number): Array<Omit<Guide, 'id' | 'created_at' | 'updated_at'>> {
  return Array.from({ length: count }, (_, i) => ({
    title: `Test Guide ${i + 1}`,
    content: `Content for guide ${i + 1}. This is test content.`,
    format: 'txt' as const,
    file_path: `/guides/test/guide-${i + 1}.txt`,
  }));
}
