import nodemailer, { type Transporter } from 'nodemailer'

export interface InviteEmail {
  to: string
  roomName: string
  inviteUrl: string
}

export interface LinkEmail {
  to: string
  url: string
}

export interface Mailer {
  sendInvite(email: InviteEmail): Promise<void>
  sendVerification(email: LinkEmail): Promise<void>
  sendPasswordReset(email: LinkEmail): Promise<void>
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl)
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text })
  }

  sendInvite({ to, roomName, inviteUrl }: InviteEmail): Promise<void> {
    return this.send(
      to,
      `You have been invited to ${roomName} on CodeSync`,
      `You have been invited to collaborate in ${roomName}.\n\nJoin here: ${inviteUrl}\n`,
    )
  }

  sendVerification({ to, url }: LinkEmail): Promise<void> {
    return this.send(
      to,
      'Verify your CodeSync email',
      `Finish creating your account: ${url}\n\nThis link expires in 24 hours. If you did not sign up, ignore this email.\n`,
    )
  }

  sendPasswordReset({ to, url }: LinkEmail): Promise<void> {
    return this.send(
      to,
      'Reset your CodeSync password',
      `Choose a new password: ${url}\n\nThis link expires in 1 hour. If you did not ask for this, ignore this email.\n`,
    )
  }
}
