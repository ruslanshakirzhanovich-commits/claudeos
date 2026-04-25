import { describe, it, expect } from 'vitest'
import { discordChatId, whatsappChatId } from '../src/channel.js'

describe('channel chat-id helpers', () => {
  it('discordChatId prefixes a raw user id', () => {
    expect(discordChatId('110440505')).toBe('discord:110440505')
  })

  it('whatsappChatId expands a bare number to a JID', () => {
    expect(whatsappChatId('15551234567')).toBe('15551234567@s.whatsapp.net')
  })

  it('whatsappChatId leaves a JID unchanged', () => {
    expect(whatsappChatId('15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net')
  })
})
