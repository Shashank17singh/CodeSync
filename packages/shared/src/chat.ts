import { z } from 'zod'

export const CHAT_LIMITS = {
  maxBodyChars: 4000,
  maxMentions: 20,
  // 5 messages per 5 seconds, as a bucket that refills one per second.
  messagesPerSecond: 1,
  messageBurst: 5,
  typingPerSecond: 1,
  historyPageSize: 50,
} as const

export const chatSendSchema = z.object({
  clientMsgId: z.string().min(1).max(64),
  body: z.string().trim().min(1).max(CHAT_LIMITS.maxBodyChars),
  mentions: z.array(z.uuid()).max(CHAT_LIMITS.maxMentions).default([]),
})
export type ChatSend = z.infer<typeof chatSendSchema>

export const chatTypingSchema = z.object({ typing: z.boolean() })

// Short by design: a filter that tries to be complete mostly catches innocent words.
const PROFANITY = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cunt']
const PROFANITY_PATTERN = new RegExp(`\\b(${PROFANITY.join('|')})\\b`, 'gi')

export function maskProfanity(text: string): string {
  return text.replace(PROFANITY_PATTERN, (word) => '*'.repeat(word.length))
}
