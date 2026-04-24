import { describe, it, expect } from 'vitest'
import { classifyMemory } from '../src/memory.js'

describe('classifyMemory', () => {
  describe('English identity phrases (must stay semantic)', () => {
    it.each([
      ['my name is John', 'semantic'],
      ["I'm a data scientist", 'semantic'],
      ['I prefer dark mode', 'semantic'],
      ['remember that I use Linux', 'semantic'],
      ['I always drink coffee in the morning', 'semantic'],
      ['I never eat meat', 'semantic'],
      ['I love jazz', 'semantic'],
      ['I hate verbose APIs', 'semantic'],
    ] as const)('%s -> %s', (text, expected) => {
      expect(classifyMemory(text)).toBe(expected)
    })
  })

  describe('Russian identity phrases (regression fix — previously missed)', () => {
    it.each([
      ['меня зовут Руслан', 'semantic'],
      ['я программист, работаю с Node', 'semantic'],
      ['я живу в Алматы', 'semantic'],
      ['я предпочитаю короткие ответы', 'semantic'],
      ['запомни: я использую Linux', 'semantic'],
      ['мне нравится минимализм', 'semantic'],
      ['мне не нравится многословность', 'semantic'],
      ['я никогда не пью кофе вечером', 'semantic'],
      ['я всегда коммичу через hooks', 'semantic'],
      ['моё имя пишется через Ё', 'semantic'],
      ['мой любимый язык TypeScript', 'semantic'],
      ['я ненавижу em dashes', 'semantic'],
    ] as const)('%s -> %s', (text, expected) => {
      expect(classifyMemory(text)).toBe(expected)
    })
  })

  describe('episodic (plain conversation)', () => {
    it.each([
      ['что там по деплою?', 'episodic'],
      ['what is 2 + 2', 'episodic'],
      ['покажи последние коммиты', 'episodic'],
      ['run the tests', 'episodic'],
      ['okay thanks', 'episodic'],
    ] as const)('%s -> %s', (text, expected) => {
      expect(classifyMemory(text)).toBe(expected)
    })
  })

  describe('no false positives from substring matches', () => {
    // "my" as substring of "mystery" should NOT trigger semantic
    it('does not match English keywords inside other words', () => {
      expect(classifyMemory('the mystery is solved')).toBe('episodic')
      expect(classifyMemory('deploy to primary')).toBe('episodic')
    })

    it('does not match Russian keywords inside other words', () => {
      // "моё" inside "самоё" etc — our regex should require word boundary
      expect(classifyMemory('самое главное сегодня')).toBe('episodic')
      // "я" alone is too noisy to count on its own
      expect(classifyMemory('я')).toBe('episodic')
    })
  })
})
