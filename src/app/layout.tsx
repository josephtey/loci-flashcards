import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const sans = Inter({ variable: '--font-sans-stack', subsets: ['latin'] });
const mono = JetBrains_Mono({ variable: '--font-mono-stack', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Loci',
  description: 'A memory system fed by an Obsidian vault.',
  // Reviewing happens on a phone as often as a laptop, so it should sit on the home screen and
  // open without browser chrome.
  appleWebApp: { capable: true, title: 'Loci', statusBarStyle: 'black-translucent' },
  manifest: '/manifest.webmanifest',
  icons: { apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No maximum-scale: pinch-zoom stays available. Locking it out is an accessibility failure,
  // and the double-tap delay it usually guards against is handled by touch-action instead.
  viewportFit: 'cover',
  themeColor: '#000000',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full bg-bg text-ink">{children}</body>
    </html>
  );
}
