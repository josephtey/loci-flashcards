import type { MetadataRoute } from 'next';

/** What Safari reads when you Add to Home Screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Loci',
    short_name: 'Loci',
    description: 'A memory system fed by an Obsidian vault.',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
