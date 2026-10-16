// Invites carry a plain meeting link. A room password, when there is one,
// is a separate line the guest types. It is never placed inside the link.
// Paid one-click links that would log a guest in with the password already
// applied are not part of this release.

export const PASSWORD_LINK_NOTE = 'Paid one-click links that sign a guest in with the room password are not available. Send the plain link, and ask the guest to type the password.';

const PASSWORD_KEYS = ['password', 'pw', 'p', 'room_password', 'pass'];

export function plainLink(link, roomPassword) {
  let u;
  try { u = new URL(String(link)); } catch (e) { throw new Error('Meeting link is not a URL.'); }
  for (const k of PASSWORD_KEYS) u.searchParams.delete(k);
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  for (const k of PASSWORD_KEYS) h.delete(k);
  const hs = h.toString();
  u.hash = hs || '';
  const out = u.toString();
  const secret = String(roomPassword || '');
  if (secret && (out.includes(secret) || out.includes(encodeURIComponent(secret)))) {
    throw new Error('The meeting link must not contain the room password. Send the plain link, and type the password separately.');
  }
  return out;
}

export function urlsOf(text) {
  return String(text || '').match(/https?:\/\/[^\s<>)"]+/g) || [];
}

export function formatInvite({ topic, link, roomPassword, startTime }) {
  const url = plainLink(link, roomPassword);
  const lines = [];
  lines.push(topic ? String(topic) : 'GifOS meeting');
  if (startTime) lines.push('When: ' + String(startTime));
  lines.push('');
  lines.push('Join: ' + url);
  lines.push('');
  if (roomPassword) {
    lines.push('Room password (type this yourself; it is not part of the link):');
    lines.push(String(roomPassword));
  } else {
    lines.push('This meeting has no room password.');
  }
  lines.push('');
  lines.push(PASSWORD_LINK_NOTE);
  const email = lines.join('\n');
  return {
    link: url,
    email,
    calendar: {
      summary: topic ? String(topic) : 'GifOS meeting',
      description: email,
      url,
      location: url,
    },
  };
}
