import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const sans = Inter({ variable: '--font-sans-stack', subsets: ['latin'] });
const mono = JetBrains_Mono({ variable: '--font-mono-stack', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Loci',
  description: 'A memory system fed by an Obsidian vault.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full bg-bg text-ink">{children}</body>
    </html>
  );
}
