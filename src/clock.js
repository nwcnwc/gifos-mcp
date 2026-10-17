// The schedule clock. One tick decides who joins, who waits, and who leaves.
// It does not read a calendar. Callers pass `now` so a test can move the clock.
import { QUIET_MS, briefOrder, capacityPicture, publicOrder } from './schedule.js';

function idKey(rows) {
  return (rows || []).map((row) => row.occurrence_id || row.schedule_id || row.meeting_id || '').join(',');
}

export function createClock(deps) {
  const quietMs = deps.quietMs > 0 ? deps.quietMs : QUIET_MS;
  const seen = new Set();
  let booted = false;
  let timer = null;

  function emit(type, meetingId, data) {
    if (typeof deps.emit !== 'function') return null;
    return deps.emit({ type, meeting_id: meetingId || '', data: data || {} });
  }

  function emitCapacity(now, force) {
    const picture = capacityPicture({
      orders: deps.schedule.all(),
      liveMeetings: deps.meetings.all().filter((m) => m.state === 'live').map((m) => ({ meeting_id: m.meeting_id, topic: m.topic || '' })),
      cap: deps.cap,
      near: deps.near,
      now,
      horizonMs: deps.horizonMs,
    });
    const alerts = [];
    if (picture.live.level !== 'ok') {
      alerts.push({
        when: 'live',
        level: picture.live.level,
        at: new Date(now).toISOString(),
        seated: picture.live.seated,
        affected: picture.live.affected,
        waiting: picture.live.waiting,
      });
    }
    for (const row of picture.upcoming) {
      alerts.push({
        when: 'scheduled',
        level: row.level,
        at: row.at,
        seated: row.seated,
        affected: row.affected,
        waiting: row.waiting,
      });
    }
    const keys = new Set(alerts.map((row) => [row.when, row.level, row.at, idKey(row.affected), idKey(row.waiting)].join('|')));
    if (!alerts.length) {
      if (booted && seen.size) {
        emit('capacity.cleared', '', { when: 'live', at: new Date(now).toISOString(), cap: deps.cap, near: deps.near, seated: picture.live.seated, affected: [], waiting: [] });
      }
      seen.clear();
      booted = true;
      return picture;
    }
    for (const row of alerts) {
      const key = [row.when, row.level, row.at, idKey(row.affected), idKey(row.waiting)].join('|');
      if (!force && seen.has(key)) continue;
      const type = row.level === 'reached' ? 'capacity.reached' : 'capacity.near';
      emit(type, '', {
        when: row.when,
        at: row.at,
        cap: deps.cap,
        near: deps.near,
        seated: row.seated,
        affected: row.affected,
        waiting: row.waiting,
      });
      seen.add(key);
    }
    for (const key of [...seen]) if (!keys.has(key)) seen.delete(key);
    booted = true;
    return picture;
  }

  async function tick(now = Date.now()) {
    deps.schedule.materialize(now, deps.horizonMs);
    deps.schedule.save();
    const orders = deps.schedule.all().filter((o) => o.phase !== 'series' && o.phase !== 'cancelled' && o.phase !== 'ended' && o.phase !== 'missed' && o.phase !== 'left_early');
    for (const order of orders) {
      const start = Date.parse(order.start);
      const end = Date.parse(order.end);
      const joinAt = start - (order.early_margin == null ? 60000 : order.early_margin);
      const meeting = order.meeting_id ? deps.meetings.get(order.meeting_id) : null;
      const seated = meeting && meeting.state === 'live';
      if ((order.phase === 'upcoming' || order.phase === 'waiting_for_capacity') && now >= end) {
        const reason = order.phase === 'waiting_for_capacity' ? 'capacity' : 'late';
        deps.schedule.setPhase(order.occurrence_id || order.schedule_id, { phase: 'missed', missed_reason: reason });
        emit('schedule.missed', order.meeting_id, { ...briefOrder(order), reason });
        continue;
      }
      if ((order.phase === 'upcoming' || order.phase === 'waiting_for_capacity') && now >= joinAt && now < end) {
        const liveCount = deps.meetings.all().filter((m) => m.state === 'live').length;
        if (liveCount >= deps.cap) {
          if (order.phase !== 'waiting_for_capacity') {
            deps.schedule.setPhase(order.occurrence_id || order.schedule_id, { phase: 'waiting_for_capacity' });
            emit('schedule.waiting', order.meeting_id, briefOrder(order));
          }
          continue;
        }
        emit('schedule.due', order.meeting_id, briefOrder(order));
        try {
          const joined = await deps.join(order);
          deps.schedule.setPhase(order.occurrence_id || order.schedule_id, { phase: 'live', meeting_id: joined.meeting_id });
          emit('meeting.joined', joined.meeting_id, { topic: order.topic, link: order.link, state: 'live', schedule_id: order.schedule_id });
        } catch (e) {
          emit('meeting.error', order.meeting_id, { text: 'The room could not be entered.' });
        }
        continue;
      }
      const restarted = (order.phase === 'live' || order.phase === 'overrun') && !seated;
      if (restarted) {
        const liveCount = deps.meetings.all().filter((m) => m.state === 'live').length;
        if (liveCount >= deps.cap) continue;
        try {
          const joined = await deps.join(order);
          deps.schedule.setPhase(order.occurrence_id || order.schedule_id, { phase: now >= end ? 'overrun' : 'live', meeting_id: joined.meeting_id, overrun_at: now >= end ? new Date(now).toISOString() : '' });
          emit('meeting.joined', joined.meeting_id, { topic: order.topic, link: order.link, state: 'live', schedule_id: order.schedule_id });
        } catch (e) {
          emit('meeting.error', order.meeting_id, { text: 'The room could not be entered.' });
        }
      }
      const fresh = deps.schedule.get(order.occurrence_id || order.schedule_id) || order;
      const freshMeeting = fresh.meeting_id ? deps.meetings.get(fresh.meeting_id) : meeting;
      if ((fresh.phase === 'live' || fresh.phase === 'overrun') && freshMeeting && freshMeeting.state === 'live' && now >= end) {
        if (fresh.phase !== 'overrun') {
          deps.schedule.setPhase(fresh.occurrence_id || fresh.schedule_id, { phase: 'overrun', overrun_at: fresh.overrun_at || new Date(now).toISOString() });
          emit('schedule.overrun', fresh.meeting_id, { ...briefOrder(fresh), overrun_quiet_minutes: quietMs / 60000 });
        }
        const current = deps.schedule.get(fresh.occurrence_id || fresh.schedule_id) || fresh;
        let humans = null;
        if (typeof deps.people === 'function') {
          try { humans = await deps.people(freshMeeting); } catch (e) { humans = null; }
        }
        const humanCount = Array.isArray(humans) ? humans.filter((p) => !p.bot).length : null;
        if (humanCount === 0) {
          await deps.leave(current, 'empty');
          continue;
        }
        const last = typeof deps.lastHumanAt === 'function' ? deps.lastHumanAt(freshMeeting.meeting_id) : null;
        const since = last != null ? last : Date.parse(current.overrun_at || new Date(now).toISOString());
        if (now - since >= quietMs) await deps.leave(current, 'quiet');
      }
    }
    // Meetings a lost worker dropped that no order will bring back.
    if (typeof deps.reseat === 'function') {
      for (const m of deps.meetings.all()) {
        if (!m.reseat || m.state !== 'scheduled' || deps.schedule.forMeeting(m.meeting_id)) continue;
        if (deps.meetings.all().filter((row) => row.state === 'live').length >= deps.cap) break;
        try {
          const joined = await deps.reseat(m);
          emit('meeting.joined', joined.meeting_id, { topic: joined.topic, link: joined.link, state: 'live', reason: 'worker' });
        } catch (e) {
          emit('meeting.error', m.meeting_id, { text: 'The room could not be entered.' });
        }
      }
    }
    return emitCapacity(now, !booted);
  }

  return {
    tick,
    emitCapacity,
    picture(now = Date.now()) {
      return capacityPicture({
        orders: deps.schedule.all(),
        liveMeetings: deps.meetings.all().filter((m) => m.state === 'live').map((m) => ({ meeting_id: m.meeting_id, topic: m.topic || '' })),
        cap: deps.cap,
        near: deps.near,
        now,
        horizonMs: deps.horizonMs,
      });
    },
    start(ms = 15000) {
      if (timer) return timer;
      timer = setInterval(() => { tick().catch(() => {}); }, ms);
      if (timer.unref) timer.unref();
      return timer;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    publicOrder,
  };
}
