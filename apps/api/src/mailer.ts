import type { FastifyBaseLogger } from 'fastify'

export interface InviteEmail {
  to: string
  roomName: string
  inviteUrl: string
}

export interface Mailer {
  sendInvite(email: InviteEmail): Promise<void>
}

// Stands in until an email provider is configured. The invite link is left out because a log
// line must not grant access to a room.
export class LogMailer implements Mailer {
  constructor(private readonly logger: FastifyBaseLogger) {}

  async sendInvite({ to, roomName }: InviteEmail): Promise<void> {
    this.logger.info({ to, roomName }, 'invite email not sent: no mail provider configured')
  }
}
