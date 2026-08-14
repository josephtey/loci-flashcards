import { NextResponse } from 'next/server';
import { vaultStatus } from '@/lib/environment';

/** Whether this instance can reach the vault, for client components that need to grey out. */
export async function GET() {
  return NextResponse.json(await vaultStatus());
}
