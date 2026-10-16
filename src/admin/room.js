// Speaks the admin-room protocol. `transport(msg)` sends one controller
// message and resolves with the bot's reply (already decoded).
export class AdminRoom {
  constructor(transport) {
    this.transport = transport;
    this.seq = 0;
  }

  async call(op, fields) {
    this.seq += 1;
    const msg = Object.assign({ v: 1, role: 'controller', op: String(op), id: 'q' + this.seq.toString(36) }, fields || {});
    delete msg.passwordAdmin;
    delete msg.adminPassword;
    delete msg.botPassword;
    const reply = await this.transport(msg);
    if (!reply || reply.op === 'err') {
      const text = (reply && reply.text) || 'The admin room refused the command.';
      const err = new Error(text);
      err.unknown = /unknown command/i.test(text);
      err.op = op;
      throw err;
    }
    if (reply.ref && reply.ref !== msg.id) throw new Error('The admin room answered a different command.');
    return reply;
  }
}
