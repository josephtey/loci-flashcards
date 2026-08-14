import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { ANGLES, type Angle } from '@/lib/types';

/**
 * Triage a reinforcement target.
 *
 * Rejections and angle corrections both write to `extraction_feedback`, where the next scan
 * picks them up as negative examples. That loop is the point: the extractor gets sharper at
 * Joseph's taste over weeks in a way no amount of up-front prompting achieves.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as { action: string; reason?: string; angle?: Angle };
  const db = supabase();

  const { data: target, error: loadError } = await db
    .from('targets')
    .select('id, excerpt, angle')
    .eq('id', id)
    .single();
  if (loadError || !target) {
    return NextResponse.json({ error: 'Target not found' }, { status: 404 });
  }

  switch (body.action) {
    case 'approve': {
      await db
        .from('targets')
        .update({ status: 'approved', reviewed_at: new Date().toISOString() })
        .eq('id', id);
      return NextResponse.json({ ok: true });
    }

    case 'reject': {
      await db
        .from('targets')
        .update({
          status: 'rejected',
          reject_reason: body.reason ?? null,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id);

      // Candidates written for a rejected target go with it.
      await db
        .from('cards')
        .update({ status: 'retired', reject_reason: 'target rejected' })
        .eq('target_id', id)
        .eq('status', 'proposed');

      await db.from('extraction_feedback').insert({
        target_id: id,
        kind: 'target_rejected',
        reason: body.reason ?? null,
        original: target.excerpt as string,
      });

      return NextResponse.json({ ok: true });
    }

    case 'set-angle': {
      if (!body.angle || !ANGLES.includes(body.angle)) {
        return NextResponse.json({ error: 'Unknown angle' }, { status: 400 });
      }
      await db.from('targets').update({ angle: body.angle }).eq('id', id);
      await db.from('extraction_feedback').insert({
        target_id: id,
        kind: 'target_angle_changed',
        original: target.angle as string,
        corrected: body.angle,
      });
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
  }
}
