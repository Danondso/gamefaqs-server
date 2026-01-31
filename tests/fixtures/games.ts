import type { Game } from '../../src/types';

export const sampleGameData = {
  basic: {
    title: 'Super Mario Bros.',
    platform: 'NES',
  },
  withRAId: {
    title: 'Final Fantasy VII',
    platform: 'PlayStation',
    ra_game_id: 'ra-ff7-001',
  },
  withMetadata: {
    title: 'The Legend of Zelda',
    platform: 'NES',
    metadata: JSON.stringify({
      external_id: 'zelda-nes-001',
      genre: 'Action-Adventure',
      release_year: 1986,
    }),
  },
  inProgress: {
    title: 'Chrono Trigger',
    platform: 'SNES',
    status: 'in_progress' as const,
    completion_percentage: 45,
  },
  completed: {
    title: 'Super Metroid',
    platform: 'SNES',
    status: 'completed' as const,
    completion_percentage: 100,
  },
  withArtwork: {
    title: 'Pokemon Red',
    platform: 'Game Boy',
    artwork_url: 'https://example.com/pokemon-red.jpg',
  },
};

export const searchableGames = [
  { title: 'Super Mario Bros.', platform: 'NES' },
  { title: 'Super Mario Bros. 2', platform: 'NES' },
  { title: 'Super Mario Bros. 3', platform: 'NES' },
  { title: 'Super Mario World', platform: 'SNES' },
  { title: 'Mario Kart 64', platform: 'N64' },
  { title: 'The Legend of Zelda', platform: 'NES' },
  { title: 'Zelda II: Adventure of Link', platform: 'NES' },
  { title: 'A Link to the Past', platform: 'SNES' },
];

export function createManyGames(count: number): Array<Omit<Game, 'id' | 'created_at' | 'updated_at' | 'completion_percentage' | 'status'>> {
  const platforms = ['NES', 'SNES', 'N64', 'PlayStation', 'Game Boy'];
  return Array.from({ length: count }, (_, i) => ({
    title: `Test Game ${i + 1}`,
    platform: platforms[i % platforms.length],
  }));
}
