import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SmtpMailer } from '../src/mailer.js'

interface Received {
  to: string[]
  message: string
}

// A real SMTP conversation against a local server, so this covers what the mail library sends.
describe('SmtpMailer', () => {
  const received: Received[] = []
  let server: SMTPServer
  let mailer: SmtpMailer

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, session, callback) {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          received.push({
            to: session.envelope.rcptTo.map((address) => address.address),
            message: Buffer.concat(chunks).toString('utf8'),
          })
          callback()
        })
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.server.address() as AddressInfo
    mailer = new SmtpMailer(`smtp://127.0.0.1:${port}`, 'CodeSync <no-reply@codesync.test>')
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('delivers a verification email with the link', async () => {
    await mailer.sendVerification({
      to: 'ada@example.test',
      url: 'https://app.test/verify-email#token=abc',
    })
    const mail = received.at(-1)
    expect(mail?.to).toEqual(['ada@example.test'])
    expect(mail?.message).toContain('Subject: Verify your CodeSync email')
    expect(mail?.message).toContain('verify-email#token=abc')
  })

  it('delivers a password reset email', async () => {
    await mailer.sendPasswordReset({ to: 'ada@example.test', url: 'https://app.test/r#token=x' })
    expect(received.at(-1)?.message).toContain('Subject: Reset your CodeSync password')
  })

  it('cannot have headers injected through a room name', async () => {
    await mailer.sendInvite({
      to: 'ada@example.test',
      roomName: 'Room\r\nBcc: attacker@evil.test',
      inviteUrl: 'https://app.test/invite#token=x',
    })
    const mail = received.at(-1)
    expect(mail?.to).toEqual(['ada@example.test'])
    // A room name may reach the body, which is harmless. It must never reach the headers.
    const headers = mail?.message.split('\r\n\r\n')[0]
    expect(headers).not.toMatch(/^Bcc:/im)
  })
})
